import { LandingPage } from '@/app/(dashboard)/landing/landing-page';
import { getUser } from '@/lib/db/queries';
import { redirect } from 'next/navigation';

export default async function HomePage() {
  const user = await getUser();

  if (user) {
    redirect('/dashboard');
  }

  return <LandingPage />;
}
