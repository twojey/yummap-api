import { assertEquals, assertExists } from "@std/assert";
import type { IMapQueryService, BoundingBox, PinFilters, Pin } from "../../../src/domain/map/map.query.ts";

class StubMapQueryService implements IMapQueryService {
  private pins: Pin[];

  constructor(pins: Pin[]) {
    this.pins = pins;
  }

  async getPins(bbox: BoundingBox, filters: PinFilters, userId?: string): Promise<Pin[]> {
    if (!filters.guideIds?.length) return [];

    return this.pins.filter((p) => {
      const inBbox =
        p.lat > bbox.swLat && p.lat < bbox.neLat &&
        p.lng > bbox.swLng && p.lng < bbox.neLng;
      const inGuide = filters.guideIds!.some((id) => p.guideIds.includes(id));
      const openFilter = filters.openNow == null || p.openNow === filters.openNow;
      return inBbox && inGuide && openFilter;
    });
  }
}

const paris: BoundingBox = { swLat: 48.80, swLng: 2.20, neLat: 48.90, neLng: 2.40 };

const makePin = (id: string, guideId: string, openNow = true): Pin => ({
  restaurantId: id,
  placeId: `place_${id}`,
  name: `Restaurant ${id}`,
  lat: 48.85,
  lng: 2.33,
  cuisineType: "french",
  openNow,
  googleRating: 4.2,
  hasVideos: true,
  isInWatchlist: false,
  guideIds: [guideId],
});

Deno.test("IMapQueryService — retourne [] sans Guide actif", async () => {
  const service = new StubMapQueryService([makePin("r1", "g1")]);
  const result = await service.getPins(paris, {});
  assertEquals(result, []);
});

Deno.test("IMapQueryService — retourne les Pins du Guide actif", async () => {
  const service = new StubMapQueryService([makePin("r1", "g1"), makePin("r2", "g2")]);
  const result = await service.getPins(paris, { guideIds: ["g1"] });
  assertEquals(result.length, 1);
  assertEquals(result[0].restaurantId, "r1");
});

Deno.test("IMapQueryService — plusieurs Guides retournent leurs Pins respectifs", async () => {
  const service = new StubMapQueryService([makePin("r1", "g1"), makePin("r2", "g2")]);
  const result = await service.getPins(paris, { guideIds: ["g1", "g2"] });
  assertEquals(result.length, 2);
});

Deno.test("IMapQueryService — filtre openNow", async () => {
  const service = new StubMapQueryService([
    makePin("r1", "g1", true),
    makePin("r2", "g1", false),
  ]);
  const result = await service.getPins(paris, { guideIds: ["g1"], openNow: true });
  assertEquals(result.length, 1);
  assertEquals(result[0].restaurantId, "r1");
});

Deno.test("IMapQueryService — isInWatchlist préservé", async () => {
  const pinWithWatchlist: Pin = { ...makePin("r1", "g1"), isInWatchlist: true };
  const service = new StubMapQueryService([pinWithWatchlist]);
  const result = await service.getPins(paris, { guideIds: ["g1"] });
  assertEquals(result[0].isInWatchlist, true);
});
