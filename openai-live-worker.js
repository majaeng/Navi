// ══════════════════════════════════════════════════════
//  openai-live-worker.js
//  gpt-realtime-translate 세션용 단기 토큰 발급기
//
//  브라우저가 OpenAI 와 직접 WebRTC 로 연결하는데,
//  거기에 진짜 API 키를 넘길 수는 없다(공개 저장소에 올라간다).
//  그래서 이 워커가 짧게 유효한 임시 열쇠를 대신 받아서 넘겨준다.
//  ── AssemblyAI 토큰 워커와 같은 구조다.
//
//  ── 배포 ──
//   1. Cloudflare → Workers → 새 워커 (이름: openai-live)
//   2. 이 파일 내용 붙여넣기 → Deploy
//   3. Settings → Variables and Secrets → Add
//        Type: Secret
//        Key : OPENAI_API_KEY
//        Value: sk-... (OpenAI 키 전체)
//      → Deploy
//
//  확인: 워커 주소를 브라우저로 열면 {"ok":true,...} 가 나온다.
// ══════════════════════════════════════════════════════

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const key = env.OPENAI_API_KEY;
    if (!key) return json({ error: 'OPENAI_API_KEY 가 설정되지 않았습니다' }, 500);

    // 목표 언어. 기본은 한국어.
    // ※ 한국어가 지원 목록에 없으면 여기서 오류가 돌아온다 —
    //   그게 바로 우리가 확인하려는 것이다.
    let lang = 'ko';
    if (request.method === 'POST') {
      try {
        const body = await request.json();
        if (body && body.language) lang = String(body.language);
      } catch (e) { /* 기본값을 쓴다 */ }
    } else {
      const q = new URL(request.url).searchParams.get('language');
      if (q) lang = q;
    }

    try {
      const res = await fetch(
        'https://api.openai.com/v1/realtime/translations/client_secrets',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            session: {
              model: 'gpt-realtime-translate',
              audio: { output: { language: lang } },
            },
          }),
        }
      );

      const data = await res.json();
      if (!res.ok) {
        // 오류 내용을 그대로 넘긴다. 감춰두면 원인을 못 찾는다.
        return json({
          error: data?.error?.message || ('오류 ' + res.status),
          status: res.status,
          language: lang,
        }, 502);
      }

      return json({ ok: true, language: lang, secret: data.value || data });
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
