import { redirect } from "next/navigation";
import { getCurrentUserId } from "@/lib/currentUser";
import NavBar from "@/app/components/NavBar";
import DashboardClient from "./DashboardClient";
import { buildDashboard } from "@/app/api/dashboard/route";
import { buildQuality } from "@/app/api/quality/route";

export default async function DashboardPage() {
  const userId = await getCurrentUserId();
  if (!userId) {
    redirect("/api/auth/signin");
  }

  // Fetch both concurrently from the database directly, completely eliminating 
  // the client-server waterfall network requests.
  const [dashboardResponse, qualityResponse] = await Promise.all([
    buildDashboard(),
    buildQuality()
  ]);

  const dashboardData = await dashboardResponse.json();
  const qualityData = await qualityResponse.json();

  return (
    <>
      <NavBar />
      <DashboardClient data={dashboardData} quality={qualityData} />
    </>
  );
}
