import { BigQuery } from "@google-cloud/bigquery";

import type { MonthlyUsageLimit } from "../domain/monthly-usage-limit";
import type { UsageLimitProvider } from "../ports/usage-limit-provider";

const MONTHLY_BUDGET_USD = 10;

export class VertexAiUsageProvider implements UsageLimitProvider {
  private readonly bigQuery: BigQuery;

  constructor(
    projectId: string,
    private readonly billingTable: string,
  ) {
    if (!/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+$/.test(billingTable)) {
      throw new Error("GOOGLE_CLOUD_BILLING_TABLE must be project.dataset.table");
    }
    this.bigQuery = new BigQuery({ projectId });
  }

  async getMonthlyUsageLimit(): Promise<MonthlyUsageLimit> {
    const [rows] = await this.bigQuery.query({
      params: {
        monthStart: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth())),
      },
      query: `
        SELECT COALESCE(SUM(cost + COALESCE((
          SELECT SUM(credit.amount) FROM UNNEST(credits) AS credit
        ), 0)), 0) AS cost
        FROM \`${this.billingTable}\`
        WHERE service.description = 'Vertex AI'
          AND usage_start_time >= @monthStart
          AND currency = 'USD'
      `,
    });
    const cost = Number(rows[0]?.cost ?? 0);
    if (!Number.isFinite(cost)) {
      throw new Error("Vertex AI billing query returned an invalid cost");
    }

    return {
      status: "ok",
      usedPercentage: (cost / MONTHLY_BUDGET_USD) * 100,
    };
  }
}
