import type { NotificationEvent } from "./notification.events.ts";

export interface INotificationDispatcher {
  dispatch(event: NotificationEvent): Promise<void>;
}
