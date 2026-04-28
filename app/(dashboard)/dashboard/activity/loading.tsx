import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DashboardPageHeader,
  DashboardPageShell
} from '@/components/dashboard/dashboard-ui';

export default function ActivityPageSkeleton() {
  return (
    <DashboardPageShell>
      <DashboardPageHeader title="Activity Log" />
      <Card>
        <CardHeader>
          <CardTitle>Recent Activity</CardTitle>
        </CardHeader>
        <CardContent className="min-h-[88px]" />
      </Card>
    </DashboardPageShell>
  );
}
