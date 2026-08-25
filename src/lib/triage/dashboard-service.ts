import "server-only";

import { getProviderSelection } from "@/lib/config/env";
import { initializeDb, listMessageViews, type AppDatabase } from "@/lib/db";
import {
  dashboardListResponseSchema,
  toDashboardMessage,
  type DashboardListResponse,
} from "@/lib/domain/dashboard";

interface DashboardDataDependencies {
  database?: AppDatabase;
  provider?: ReturnType<typeof getProviderSelection>;
}

export function getDashboardData(
  dependencies: DashboardDataDependencies = {},
): DashboardListResponse {
  const database = dependencies.database ?? initializeDb();
  const provider = dependencies.provider ?? getProviderSelection();

  return dashboardListResponseSchema.parse({
    messages: listMessageViews(database).map(toDashboardMessage),
    provider: {
      name: provider.name,
      model: provider.model,
      configured: provider.configured,
    },
  });
}
