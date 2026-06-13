export function buildSourceCropFilter(cropSettings?: Record<string, unknown> | null) {
  const sourceCrop = cropSettings?.sourceCrop;

  if (sourceCrop === '1_1') {
    return 'crop=min(iw\\,ih):min(iw\\,ih):(iw-ow)/2:(ih-oh)/2';
  }

  if (sourceCrop === '4_3') {
    return [
      'crop=',
      'if(gte(iw/ih\\,4/3)\\,ih*4/3\\,iw):',
      'if(gte(iw/ih\\,4/3)\\,ih\\,iw*3/4):',
      '(iw-ow)/2:',
      '(ih-oh)/2',
    ].join('');
  }

  return null;
}
