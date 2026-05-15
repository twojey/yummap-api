import { config } from "../../config.ts";
import { SupabaseRestaurantRepository } from "../infrastructure/repositories/supabase-restaurant.repository.ts";
import { SupabaseGuideRepository } from "../infrastructure/repositories/supabase-guide.repository.ts";
import { SupabaseUserRepository } from "../infrastructure/repositories/supabase-user.repository.ts";
import { SupabaseVideoImportRequestRepository } from "../infrastructure/repositories/supabase-video-import-request.repository.ts";
import { SupabaseVideoDedupRepository } from "../infrastructure/repositories/supabase-video-dedup.repository.ts";
import { SupabaseInvitationRepository } from "../infrastructure/repositories/supabase-invitation.repository.ts";
import { PostgisMapQueryService } from "../infrastructure/map/postgis-map-query.service.ts";
import { VideoImportPipeline } from "../infrastructure/video/video-import-pipeline.ts";
import { CascadingDownloader } from "../infrastructure/video/downloaders/cascading-downloader.ts";
import { YtDlpDownloader } from "../infrastructure/video/downloaders/ytdlp-downloader.ts";
import { GalleryDlDownloader } from "../infrastructure/video/downloaders/gallery-dl-downloader.ts";
import { HttpFallbackDownloader } from "../infrastructure/video/downloaders/http-fallback-downloader.ts";
import { TikWmDownloader } from "../infrastructure/video/downloaders/tikwm-downloader.ts";
import { WhisperTranscriptionAdapter } from "../infrastructure/video/whisper-transcription.adapter.ts";
import { GeminiDetectorAdapter } from "../infrastructure/video/gemini-detector.adapter.ts";
import { GroqDetectorAdapter } from "../infrastructure/video/groq-detector.adapter.ts";
import { OpenAIDetectorAdapter } from "../infrastructure/video/openai-detector.adapter.ts";
import { FallbackDetector } from "../infrastructure/video/fallback-detector.ts";
import { FcmPushAdapter } from "../infrastructure/notifications/fcm-push.adapter.ts";
import { TelegramBotAdapter } from "../infrastructure/notifications/telegram-bot.adapter.ts";
import { NotificationDispatcher } from "../infrastructure/notifications/notification-dispatcher.ts";
import { GooglePlacesClient } from "../infrastructure/google-places/google-places.client.ts";
import { ImportVideoUsecase } from "../application/video/import-video.usecase.ts";
import { CreateGuideUsecase } from "../application/guide/create-guide.usecase.ts";
import { OnboardingUsecase } from "../application/user/onboarding.usecase.ts";
import { BulkProfileImportUsecase } from "../application/import/bulk-profile-import.usecase.ts";
import { CreateAdminInvitationUsecase } from "../application/influencer/create-admin-invitation.usecase.ts";
import { CreateInfluencerInvitationUsecase } from "../application/influencer/create-influencer-invitation.usecase.ts";
import { ClaimInvitationUsecase } from "../application/influencer/claim-invitation.usecase.ts";
import { ApproveInfluencerUsecase } from "../application/influencer/approve-influencer.usecase.ts";
import { EnrichRestaurantGoogleDataUsecase } from "../application/restaurant/enrich-google-data.usecase.ts";
import { CookiesHealthMonitor } from "../application/monitoring/cookies-health.usecase.ts";
import { SupabaseImportJobRepository } from "../infrastructure/repositories/supabase-import-job.repository.ts";
import type { IRestaurantRepository } from "../domain/restaurant/restaurant.repository.ts";
import type { IGuideRepository } from "../domain/guide/guide.repository.ts";
import type { IUserRepository } from "../domain/user/user.repository.ts";
import type { IMapQueryService } from "../domain/map/map.query.ts";
import type { IImportJobRepository } from "../domain/import-job/import-job.repository.ts";
import type { IVideoImportRequestRepository } from "../domain/video/video-import-request.repository.ts";
import type { IInfluencerInvitationRepository } from "../domain/influencer/invitation.repository.ts";

export interface AppContainer {
  // Mode de déploiement courant : "api" (Deno Deploy, pas de pipeline ni
  // schedulers), "worker" (VM, tout activé), "all" (dev local, tout dans un
  // seul process). Consommé par les routes/handlers pour décider sync vs
  // enqueue-only.
  deployMode: "api" | "worker" | "all";
  restaurantRepo: IRestaurantRepository;
  guideRepo: IGuideRepository;
  userRepo: IUserRepository;
  mapQuery: IMapQueryService;
  placesClient: GooglePlacesClient;
  notifications: NotificationDispatcher;
  importVideo: ImportVideoUsecase;
  createGuide: CreateGuideUsecase;
  onboarding: OnboardingUsecase;
  bulkProfileImport: BulkProfileImportUsecase;
  importJobRepo: IImportJobRepository;
  videoImportRequestRepo: IVideoImportRequestRepository;
  invitationRepo: IInfluencerInvitationRepository;
  createAdminInvitation: CreateAdminInvitationUsecase;
  createInfluencerInvitation: CreateInfluencerInvitationUsecase;
  claimInvitation: ClaimInvitationUsecase;
  approveInfluencer: ApproveInfluencerUsecase;
  enrichRestaurantGoogleData: EnrichRestaurantGoogleDataUsecase;
  cookiesHealth: CookiesHealthMonitor;
}

export function createContainer(): AppContainer {
  const restaurantRepo = new SupabaseRestaurantRepository();
  const guideRepo = new SupabaseGuideRepository();
  const userRepo = new SupabaseUserRepository();
  const mapQuery = new PostgisMapQueryService();
  const importJobRepo = new SupabaseImportJobRepository();
  const videoImportRequestRepo = new SupabaseVideoImportRequestRepository();
  const invitationRepo = new SupabaseInvitationRepository();

  const placesClient = new GooglePlacesClient();
  const transcription = new WhisperTranscriptionAdapter();
  // Chaîne de détection : Groq (free 1000/j, ~70ms) → Gemini (free 20/j) → OpenAI (payant)
  // Groq d'abord car plus rapide ET quota plus généreux. FallbackDetector imbriqué :
  // la propagation des DailyQuotaExceededError fait descendre dans la chaîne automatiquement.
  const detector = new FallbackDetector(
    new GroqDetectorAdapter(),
    new FallbackDetector(
      new GeminiDetectorAdapter(),
      new OpenAIDetectorAdapter(),
    ),
  );
  // EnrichRestaurantGoogleDataUsecase est instancié AVANT le pipeline pour
  // pouvoir lui être injecté — l'ordre compte.
  const enrichRestaurantGoogleDataInst = new EnrichRestaurantGoogleDataUsecase(placesClient);
  const videoDedupRepo = new SupabaseVideoDedupRepository();

  // Cascade de téléchargement Instagram/TikTok.
  // Ordre : le plus stable / rapide en premier, le fallback HTTP en dernier.
  // gallery-dl ne sait gérer qu'Instagram → CascadingDownloader le saute
  // proprement pour les autres URLs via DownloaderError("unsupported_url").
  const videoDownloader = new CascadingDownloader([
    new YtDlpDownloader(),
    // TikWm sert de filet pour TikTok quand yt-dlp echoue (TLS fingerprint).
    // Skip les URLs non-TikTok via `unsupported_url`, donc transparent pour IG.
    new TikWmDownloader(),
    new GalleryDlDownloader(),
    new HttpFallbackDownloader(),
  ]);

  const pipeline = new VideoImportPipeline(
    videoDownloader,
    transcription,
    detector,
    restaurantRepo,
    placesClient,
    enrichRestaurantGoogleDataInst,
    videoDedupRepo,
  );

  const pushProvider = new FcmPushAdapter();
  const telegram = new TelegramBotAdapter();
  const notifications = new NotificationDispatcher(pushProvider, telegram);

  const importVideo = new ImportVideoUsecase(pipeline, notifications);
  const createGuide = new CreateGuideUsecase(guideRepo, notifications);
  const onboarding = new OnboardingUsecase(userRepo);
  const bulkProfileImport = new BulkProfileImportUsecase(importJobRepo, pipeline, notifications);

  const createAdminInvitation = new CreateAdminInvitationUsecase(invitationRepo, bulkProfileImport, importJobRepo);
  const createInfluencerInvitation = new CreateInfluencerInvitationUsecase(invitationRepo);
  const claimInvitation = new ClaimInvitationUsecase(invitationRepo, userRepo);
  const approveInfluencer = new ApproveInfluencerUsecase(invitationRepo, userRepo, bulkProfileImport);

  // Réutilise l'instance créée plus haut pour le pipeline — un seul singleton.
  const enrichRestaurantGoogleData = enrichRestaurantGoogleDataInst;

  const cookiesHealth = new CookiesHealthMonitor(notifications);

  return {
    deployMode: config.deployMode,
    restaurantRepo, guideRepo, userRepo, mapQuery, placesClient, notifications,
    importVideo, createGuide, onboarding, bulkProfileImport,
    importJobRepo, videoImportRequestRepo, invitationRepo,
    createAdminInvitation, createInfluencerInvitation, claimInvitation, approveInfluencer,
    enrichRestaurantGoogleData, cookiesHealth,
  };
}
