export async function POST(request: Request) {
  await request.body?.cancel().catch(() => undefined);
  return Response.json(
    { error: 'Full source video server uploads are disabled. Use multipart upload.' },
    { status: 410 }
  );
}
