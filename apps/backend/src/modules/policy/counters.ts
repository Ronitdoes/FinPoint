import type { CounterFetcher, CounterFetcherParams, CountersSnapshot } from "@repo/policy";
import type { Repositories } from "../../plugins/db";
import type { Database } from "@repo/db";

export class DatabaseCounterFetcher implements CounterFetcher {
  constructor(
    private readonly db: Database,
    private readonly repos: Repositories,
  ) {}

  async getCounters(params: CounterFetcherParams): Promise<CountersSnapshot> {
    const { tenantId, customerId } = params;
    if (!customerId) {
      return {
        whatsapp_sent_7d: 0,
        email_sent_14d: 0,
        sms_sent_7d: 0,
      };
    }

    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

    const [whatsappCount, emailCount, smsCount] = await Promise.all([
      this.repos.countCustomerMessagesByChannelSince(
        { db: this.db },
        { tenantId, customerId, channel: "WHATSAPP", since: sevenDaysAgo },
      ),
      this.repos.countCustomerMessagesByChannelSince(
        { db: this.db },
        { tenantId, customerId, channel: "EMAIL", since: fourteenDaysAgo },
      ),
      this.repos.countCustomerMessagesByChannelSince(
        { db: this.db },
        { tenantId, customerId, channel: "SMS", since: sevenDaysAgo },
      ),
    ]);

    return {
      whatsapp_sent_7d: whatsappCount,
      email_sent_14d: emailCount,
      sms_sent_7d: smsCount,
    };
  }
}
