import { headers } from "next/headers";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { TriageDashboard } from "@/components/triage-dashboard";
import { isAllowedLocalHostHeader } from "@/lib/http/triage-request-guard";
import { getDashboardData } from "@/lib/triage/dashboard-service";

export default async function HomePage() {
  await connection();
  const requestHeaders = await headers();
  if (!isAllowedLocalHostHeader(requestHeaders.get("host"))) notFound();

  const initialData = getDashboardData();
  return <TriageDashboard initialData={initialData} />;
}
