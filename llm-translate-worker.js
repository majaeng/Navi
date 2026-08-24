// ══════════════════════════════════════════════════════
//  llm-translate-worker.js
//  중국어 → 한국어, 맥락을 아는 번역
//
//  OpenRouter 를 거쳐 여러 모델을 같은 방식으로 부른다.
//  모델은 요청마다 바꿀 수 있으므로, 실제 회의 음성으로
//  비교해보고 고르면 된다.
//
//  ── 배포 ──
//   1. Cloudflare → Workers → 새 워커 → 이 파일 내용 붙여넣기
//   2. Settings → Variables → Secret 추가
//        이름: OPENROUTER_KEY
//        값 : sk-or-v1-... (OpenRouter 키 전체)
//      ※ Secret 으로 넣어야 한다. 일반 Variable 은 대시보드에 그대로 보인다.
//   3. 배포 후 주소를 cn-translate.html 의 LLM_PROXY 에 적는다
//
//  ※ 키는 여기(서버)에만 있다. 브라우저로는 절대 내려가지 않는다.
// ══════════════════════════════════════════════════════

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// 별명 → OpenRouter 모델.
//  prefer 를 먼저 찾고, 없으면 match 로 검색한다.
//  ※ 모델 이름은 수시로 바뀌므로 못박기만 하면 언젠가 깨진다.
//    그렇다고 검색만 하면 엉뚱한 걸 집는다 —
//    실제로 '가장 싼 것'을 고르게 했더니 claude-3-haiku(구형)와
//    gpt-5-nano:batch(비동기 전용)를 골라왔다.
const ALIASES = {
  haiku:    { prefer: 'anthropic/claude-haiku-4.5',
              match: ['claude', 'haiku'], avoid: ['claude-3'] },
  nano:     { prefer: 'openai/gpt-5-nano',   match: ['gpt-5-nano'], avoid: [] },
  mini:     { prefer: 'openai/gpt-5-mini',   match: ['gpt-5-mini'], avoid: [] },
  qwen:     { prefer: 'qwen/qwen3.7-flash',  match: ['qwen', 'flash'],
              avoid: ['vl', 'coder', 'max', 'omni'] },
  gemini:   { prefer: 'google/gemini-3.1-flash-lite',
              match: ['gemini', 'flash-lite'], avoid: [] },
  deepseek: { prefer: '', match: ['deepseek', 'flash'], avoid: ['r1', 'coder'] },
};

// ★ 실시간에 못 쓰는 변형은 제외한다.
//   :batch  = 모아서 나중에 처리 (싸지만 즉시 응답이 아니다)
//   :free   = 무료지만 호출 제한이 걸려 중간에 끊긴다
//   ~ 로 시작하는 것은 특수 라우팅이라 동작이 일정하지 않다
function isUsable(id) {
  return !id.includes(':') && !id.startsWith('~');
}

let modelCache = null;      // { 별명: 실제모델명 }
let modelCacheAt = 0;

async function resolveModel(alias, key) {
  // ★ 지정해둔 모델이 있으면 목록을 받지 않고 바로 쓴다.
  //   워커는 자주 새로 뜨는데, 그때마다 모델 목록을 받아오면
  //   그 왕복이 매번 번역 지연에 얹힌다.
  //   (이름이 바뀌어 실패하면 아래 목록 조회로 되돌아온다)
  if (ALIASES[alias]?.prefer) return ALIASES[alias].prefer;

  const now = Date.now();
  if (modelCache && now - modelCacheAt < 3600_000 && modelCache[alias]) {
    return modelCache[alias];
  }
  const res = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error('모델 목록을 받지 못했습니다 (' + res.status + ')');
  const list = (await res.json()).data || [];

  const ids = list.map(m => m.id || '').filter(isUsable);

  const found = {};
  for (const [name, rule] of Object.entries(ALIASES)) {
    // 1) 지정해둔 모델이 아직 있으면 그걸 쓴다
    if (rule.prefer && ids.includes(rule.prefer)) {
      found[name] = rule.prefer;
      continue;
    }
    // 2) 없으면 검색한다. 이때는 가장 싼 것이 아니라
    //    '이름이 가장 짧은 것'을 고른다 — 군더더기 없는 기본 모델이 그것이다.
    const hits = ids.filter(id => {
      const low = id.toLowerCase();
      if (!rule.match.every(w => low.includes(w))) return false;
      if (rule.avoid.some(w => low.includes(w))) return false;
      return true;
    });
    hits.sort((a, b) => a.length - b.length);
    if (hits.length) found[name] = hits[0];
  }
  modelCache = found;
  modelCacheAt = now;

  if (!found[alias]) throw new Error(`'${alias}' 에 맞는 모델을 찾지 못했습니다`);
  return found[alias];
}

// ── 지시문 ──
//  ※ 규칙을 여기 한 곳에만 적는다.
//    예전에는 이런 것들을 전부 코드의 규칙으로 만들려다 끝이 없었다.
function buildPrompt(ctx, text, terms) {
  // ※ 지시문이 길수록 첫 글자가 늦게 나온다. 모델이 이걸 다 읽고 시작하기 때문이다.
  //   (실측: 지시문을 늘리는 사이 첫글자가 950ms → 1247ms 로 밀렸다)
  //   그래서 꼭 필요한 것만 짧게 적는다.
  const rules = [
    '중국어→한국어 실시간 통역. 게임 업계 회의/식사 자리.',
    '[번역할 말]만 옮긴다. 번역문만 출력(설명·따옴표·원문 금지).',
    '존댓말(합니다체)로 통일.',
    '조각이 문장 중간에서 끊기면 끊긴 채로 둔다. "말입니다" 같은 맺음말을 덧붙이지 말 것.',
    '없는 말을 지어내지 않는다.',
    '오인식된 지명·고유명사는 맥락에 맞게 바로잡는다.',
    // ★ 금액은 틀리면 회의에서 바로 문제가 된다. 八万块 를 "8만 원" 으로 옮기면
    //   실제 1,650만원짜리 이야기가 8만원짜리로 둔갑한다.
    '금액: 块·元 은 반드시 "위안". 절대 "원"으로 바꾸지 말 것. 숫자와 단위(만·억)는 그대로 옮긴다.',
  ];
  if (terms && terms.length) {
    rules.push('용어: ' + terms.map(([zh, ko]) => `${zh}=${ko}`).join(', '));
  }

  const parts = [];
  if (ctx && ctx.length) {
    // 맥락은 2줄이면 충분하다. 늘릴수록 첫 글자가 늦어진다.
    parts.push('[앞 대화]');
    for (const c of ctx.slice(-2)) parts.push(c);
    parts.push('');
  }
  parts.push('[번역할 말]');
  parts.push(text);

  return { system: rules.join('\n'), user: parts.join('\n') };
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const key = env.OPENROUTER_KEY;
    if (!key) {
      return json({ error: 'OPENROUTER_KEY 가 설정되지 않았습니다' }, 500);
    }

    // 어떤 모델을 쓸 수 있는지 확인용
    if (request.method === 'GET') {
      try {
        await resolveModel('qwen', key);
        return json({ ok: true, models: modelCache });
      } catch (e) {
        return json({ error: String(e.message || e) }, 500);
      }
    }

    let body;
    try { body = await request.json(); }
    catch { return json({ error: '잘못된 요청' }, 400); }

    const text = (body.text || '').trim();
    if (!text) return json({ translated: '' });

    const alias = body.model || 'qwen';
    const t0 = Date.now();

    try {
      const model = await resolveModel(alias, key);
      const { system, user } = buildPrompt(body.ctx, text, body.terms);

      // ★ GPT-5 계열은 답하기 전에 속으로 '생각'을 한다.
      //   통역에는 그 생각이 필요 없는데 시간과 토큰만 쓴다.
      //   실제로 이 설정 없이는 4초 제한에 걸려 전부 실패했다.
      const thinks = model.includes('gpt-5') || model.includes('o1') ||
                     model.includes('o3') || model.includes('o4');

      const payload = {
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.2,     // 통역은 창작이 아니다
        // 생각하는 모델은 생각한 만큼도 이 한도에서 깎이므로 넉넉히 준다
        max_tokens: thinks ? 600 : 150,
        // 같은 모델이라도 제공사가 여러 곳이다. 가장 빠른 곳으로 보낸다.
        provider: { sort: 'latency' },
      };
      if (thinks) payload.reasoning = { effort: 'minimal' };

      // ── 스트리밍 ──
      // 번역이 다 끝나기를 기다리지 않고, 만들어지는 대로 흘려보낸다.
      // 첫 글자는 0.3~0.5초면 나오므로 체감 지연이 크게 준다.
      // ※ 여기서는 해석하지 않고 그대로 전달만 한다 (앱에서 읽는다).
      if (body.stream) {
        payload.stream = true;
        const up = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });
        if (!up.ok || !up.body) {
          const err = await up.text().catch(() => '');
          return json({ error: '스트리밍 실패 ' + up.status + ' ' + err.slice(0, 200) }, 502);
        }
        return new Response(up.body, {
          headers: {
            ...CORS,
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            'X-Model': model,
          },
        });
      }

      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) {
        return json({ error: data?.error?.message || ('오류 ' + res.status), model }, 502);
      }

      let out = (data?.choices?.[0]?.message?.content || '').trim();
      // 모델이 가끔 따옴표나 말머리를 붙인다. 떼어낸다.
      out = out.replace(/^["'「『]|["'」』]$/g, '').trim();
      out = out.replace(/^(번역|한국어)\s*[:：]\s*/, '').trim();

      return json({
        translated: out,
        model,
        ms: Date.now() - t0,
        usage: data?.usage || null,
      });
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
