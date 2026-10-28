import type { ChannelSessionManager } from "./channel-session-manager";
import type { ReminderDeliveryCoordinator } from "./reminder-delivery-coordinator";

export class AgentCoordinator {
  constructor(
    private readonly sessionManager: ChannelSessionManager,
    private readonly reminderDeliveryCoordinator: ReminderDeliveryCoordinator,
  ) {}

  async rotateIdleChannels(): Promise<void> {
    await this.sessionManager.rotateIdleChannels();
  }

  async initialize(): Promise<void> {
    await this.sessionManager.initialize();
  }

  async deliverDueReminders(now = Date.now()): Promise<void> {
    await this.reminderDeliveryCoordinator.deliverDueReminders(now);
  }

  async dispose(): Promise<void> {
    await this.sessionManager.dispose();
  }
}
