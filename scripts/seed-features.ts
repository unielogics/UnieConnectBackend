import { connectMongo } from '../src/config/mongo';
import { Feature } from '../src/models/feature';

const standardFeatures = [
  {
    name: 'Orders',
    slug: 'orders',
    description: 'View and manage all orders across your sales channels',
    category: 'core',
    isStandard: true,
    metadata: {
      route: '/orders',
      navLabel: 'Orders',
      navIcon: 'orders',
      navOrder: 1,
    },
    pricing: { type: 'free' as const },
    tags: ['orders', 'sales', 'core'],
    searchKeywords: ['orders', 'order management', 'sales'],
  },
  {
    name: 'Customers',
    slug: 'customers',
    description: 'Manage customer information and relationships',
    category: 'core',
    isStandard: true,
    metadata: {
      route: '/customers',
      navLabel: 'Customers',
      navIcon: 'customers',
      navOrder: 2,
    },
    pricing: { type: 'free' as const },
    tags: ['customers', 'crm', 'core'],
    searchKeywords: ['customers', 'customer management', 'crm'],
  },
  {
    name: 'Activity',
    slug: 'activity',
    description: 'View system activity logs and events',
    category: 'core',
    isStandard: true,
    metadata: {
      route: '/activity',
      navLabel: 'Activity',
      navIcon: 'activity',
      navOrder: 3,
    },
    pricing: { type: 'free' as const },
    tags: ['activity', 'logs', 'core'],
    searchKeywords: ['activity', 'logs', 'events', 'audit'],
  },
  {
    name: 'Amazon Integration',
    slug: 'amazon-integration',
    description: 'Connect and sync with Amazon Seller Central',
    category: 'integration',
    isStandard: true,
    metadata: {
      route: '/dashboard',
      navLabel: 'Integrations',
      navIcon: 'integrations',
      navOrder: 0,
    },
    pricing: { type: 'free' as const },
    tags: ['amazon', 'integration', 'marketplace'],
    searchKeywords: ['amazon', 'seller central', 'sp-api', 'integration'],
  },
  {
    name: 'Shopify Integration',
    slug: 'shopify-integration',
    description: 'Connect and sync with your Shopify store',
    category: 'integration',
    isStandard: true,
    metadata: {
      route: '/dashboard',
      navLabel: 'Integrations',
      navIcon: 'integrations',
      navOrder: 0,
    },
    pricing: { type: 'free' as const },
    tags: ['shopify', 'integration', 'ecommerce'],
    searchKeywords: ['shopify', 'store', 'ecommerce', 'integration'],
  },
  {
    name: 'eBay Integration',
    slug: 'ebay-integration',
    description: 'Connect and sync with eBay marketplace',
    category: 'integration',
    isStandard: true,
    metadata: {
      route: '/dashboard',
      navLabel: 'Integrations',
      navIcon: 'integrations',
      navOrder: 0,
    },
    pricing: { type: 'free' as const },
    tags: ['ebay', 'integration', 'marketplace'],
    searchKeywords: ['ebay', 'marketplace', 'integration'],
  },
];

const marketplaceFeatures = [
  {
    name: 'Warehouse Management',
    slug: 'warehouse-management',
    description: 'Multi-warehouse intelligence, sync, and smart allocation across all locations',
    longDescription:
      'Manage inventory across multiple warehouse locations with intelligent allocation, real-time sync, and automated fulfillment routing.',
    category: 'automation',
    isStandard: false,
    metadata: {
      route: '/warehouse',
      navLabel: 'Warehouse',
      navIcon: 'warehouse',
      navOrder: 10,
    },
    pricing: { type: 'subscription' as const, amount: 99, currency: 'USD', trialDays: 14 },
    tags: ['warehouse', 'inventory', 'fulfillment', 'automation'],
    searchKeywords: ['warehouse', 'warehousing', 'multi-warehouse', 'inventory management', 'fulfillment'],
  },
  {
    name: 'Billing Automations',
    slug: 'billing-automations',
    description: 'Streamline invoicing and payments across operations',
    longDescription:
      'Automate billing, invoicing, and payment processing across all your sales channels and operations.',
    category: 'automation',
    isStandard: false,
    metadata: {
      route: '/billing',
      navLabel: 'Billing',
      navIcon: 'billing',
      navOrder: 11,
    },
    pricing: { type: 'subscription' as const, amount: 79, currency: 'USD', trialDays: 7 },
    tags: ['billing', 'invoicing', 'payments', 'automation'],
    searchKeywords: ['billing', 'invoice', 'invoicing', 'payments', 'automation'],
  },
  {
    name: 'Product Finder',
    slug: 'product-finder',
    description: 'Discover and manage products across marketplaces',
    longDescription:
      'Find products across multiple marketplaces, compare prices, track inventory, and manage listings from one central dashboard.',
    category: 'analytics',
    isStandard: false,
    metadata: {
      route: '/product-finder',
      navLabel: 'Product Finder',
      navIcon: 'product-finder',
      navOrder: 12,
    },
    pricing: { type: 'subscription' as const, amount: 49, currency: 'USD', trialDays: 14 },
    tags: ['products', 'search', 'marketplace', 'analytics'],
    searchKeywords: ['product finder', 'product search', 'marketplace search', 'product discovery'],
  },
  {
    name: 'Continuous Auditing',
    slug: 'continuous-auditing',
    description: 'Optimal placement, storage, and routes to save money and increase profit',
    longDescription:
      'Automated auditing system that continuously analyzes your operations to optimize costs, improve efficiency, and maximize profitability.',
    category: 'analytics',
    isStandard: false,
    metadata: {
      route: '/auditing',
      navLabel: 'Auditing',
      navIcon: 'auditing',
      navOrder: 13,
    },
    pricing: { type: 'subscription' as const, amount: 149, currency: 'USD', trialDays: 7 },
    tags: ['auditing', 'analytics', 'optimization', 'cost-saving'],
    searchKeywords: ['auditing', 'audit', 'optimization', 'cost saving', 'analytics', 'profitability'],
  },
  {
    name: 'Custom Integrations',
    slug: 'custom-integrations',
    description: 'API and custom connectors for your stack',
    longDescription:
      'Build custom integrations with our API, webhooks, and connector framework. Connect any system to your UnieConnect platform.',
    category: 'integration',
    isStandard: false,
    metadata: {
      route: '/custom-integrations',
      navLabel: 'Custom Integrations',
      navIcon: 'custom-integrations',
      navOrder: 14,
    },
    pricing: { type: 'one-time' as const, amount: 299, currency: 'USD' },
    tags: ['api', 'webhooks', 'custom', 'integration', 'developer'],
    searchKeywords: ['custom integration', 'api', 'webhooks', 'connector', 'developer tools'],
  },
  {
    name: 'Multi-User Management',
    slug: 'multi-user',
    description: 'Team access and roles so everyone works in sync',
    longDescription:
      'Manage team members, assign roles and permissions, and collaborate across your organization with granular access control.',
    category: 'management',
    isStandard: false,
    metadata: {
      route: '/team',
      navLabel: 'Team',
      navIcon: 'team',
      navOrder: 15,
    },
    pricing: { type: 'subscription' as const, amount: 29, currency: 'USD', trialDays: 14 },
    tags: ['team', 'users', 'roles', 'permissions', 'collaboration'],
    searchKeywords: ['multi-user', 'team', 'users', 'roles', 'permissions', 'collaboration'],
  },
];

async function main() {
  await connectMongo();

  console.log('Seeding features...');

  // Seed standard features
  for (const featureData of standardFeatures) {
    const existing = await Feature.findOne({ slug: featureData.slug }).exec();
    if (existing) {
      console.log(`Feature "${featureData.name}" already exists, skipping...`);
      continue;
    }

    await Feature.create({
      ...featureData,
      version: '1.0.0',
      author: 'UnieConnect',
      isActive: true,
      requiredFeatures: [],
      screenshots: [],
    });
    console.log(`✓ Created standard feature: ${featureData.name}`);
  }

  // Seed marketplace features
  for (const featureData of marketplaceFeatures) {
    const existing = await Feature.findOne({ slug: featureData.slug }).exec();
    if (existing) {
      console.log(`Feature "${featureData.name}" already exists, skipping...`);
      continue;
    }

    await Feature.create({
      ...featureData,
      version: '1.0.0',
      author: 'UnieConnect',
      isActive: true,
      requiredFeatures: [],
      screenshots: [],
    });
    console.log(`✓ Created marketplace feature: ${featureData.name}`);
  }

  console.log('\n✓ Feature seeding complete!');
  process.exit(0);
}

main().catch((err) => {
  console.error('Error seeding features:', err);
  process.exit(1);
});
