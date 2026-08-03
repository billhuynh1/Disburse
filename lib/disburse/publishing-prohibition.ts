export const DIRECT_PUBLISHING_PROHIBITED_MESSAGE =
  'Direct publishing is disabled during operational verification. Download the rendered clip for manual review and publishing.';

export class DirectPublishingProhibitedError extends Error {
  readonly code = 'direct_publishing_prohibited';
  constructor() {
    super(DIRECT_PUBLISHING_PROHIBITED_MESSAGE);
    this.name = 'DirectPublishingProhibitedError';
  }
}

export function assertDirectPublishingProhibited(): void {
  throw new DirectPublishingProhibitedError();
}
