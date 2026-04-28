import { checkoutAction } from '@/lib/payments/actions';
import { Check } from 'lucide-react';
import { getStripePrices, getStripeProducts } from '@/lib/payments/stripe';
import { SubmitButton } from './submit-button';

// Prices are fresh for one hour max
export const revalidate = 3600;

export default async function PricingPage() {
  const [prices, products] = await Promise.all([
    getStripePrices(),
    getStripeProducts(),
  ]);

  const corePlan = products.find((product) => product.name === 'Core');
  const proPlan = products.find((product) => product.name === 'Pro');

  const corePrice = prices.find((price) => price.productId === corePlan?.id);
  const proPrice = prices.find((price) => price.productId === proPlan?.id);

  return (
    <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
      <div className="grid md:grid-cols-2 gap-8 max-w-xl mx-auto">
        <PricingCard
          name={corePlan?.name || 'Core'}
          price={corePrice?.unitAmount || 800}
          interval={corePrice?.interval || 'month'}
          trialDays={corePrice?.trialPeriodDays || 7}
          features={[
            'Core Disburse workspace access',
            'Workspace billing and member management',
            'Email support',
          ]}
          priceId={corePrice?.id}
        />
        <PricingCard
          name={proPlan?.name || 'Pro'}
          price={proPrice?.unitAmount || 1200}
          interval={proPrice?.interval || 'month'}
          trialDays={proPrice?.trialPeriodDays || 7}
          features={[
            'Everything in Core',
            'Priority access to new Disburse improvements',
            'Priority support',
          ]}
          priceId={proPrice?.id}
        />
      </div>
    </main>
  );
}

function PricingCard({
  name,
  price,
  interval,
  trialDays,
  features,
  priceId,
}: {
  name: string;
  price: number;
  interval: string;
  trialDays: number;
  features: string[];
  priceId?: string;
}) {
  return (
    <div className="rounded-xl border border-border/80 bg-card p-8 shadow-[0_18px_50px_rgba(5,8,22,0.18)]">
      <h2 className="mb-2 text-2xl font-medium text-foreground">{name}</h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Includes a {trialDays} day free trial
      </p>
      <p className="mb-6 text-4xl font-medium text-foreground">
        ${price / 100}{' '}
        <span className="text-xl font-normal text-muted-foreground">
          per workspace / {interval}
        </span>
      </p>
      <ul className="space-y-4 mb-8">
        {features.map((feature, index) => (
          <li key={index} className="flex items-start">
            <Check className="mr-2 mt-0.5 h-5 w-5 flex-shrink-0 text-secondary" />
            <span className="text-foreground/90">{feature}</span>
          </li>
        ))}
      </ul>
      <form action={checkoutAction}>
        <input type="hidden" name="priceId" value={priceId} />
        <SubmitButton />
      </form>
    </div>
  );
}
