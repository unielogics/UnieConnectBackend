export type ChannelListing = {
  id: string;
  channelAccountId: string;
  channelListingId: string;
  sku: string;
  inventoryItemId?: string; // Shopify specific
  locationId?: string; // Shopify specific
  status?: 'active' | 'inactive';
  createdAt?: string;
  updatedAt?: string;
};

