/* =========================================================
 * 문해력 트레이닝 - 앱 로직
 * 콘텐츠는 data.js, 화면 모양은 style.css 에 있어요.
 * ========================================================= */
(function () {
  'use strict';

  const C = window.CONTENT;
  const MODES = {
    vocab:   { name: '낱말 뜻',     ico: '📖', desc: '낱말의 뜻을 알아봐요' },
    reading: { name: '글 읽기',     ico: '📚', desc: '글을 읽고 생각해요' },
    order:   { name: '순서 맞추기', ico: '🔢', desc: '일이 일어난 차례를 찾아요' },
    connect: { name: '이어주는 말', ico: '🔗', desc: '문장을 알맞게 이어요' },
  };
  const QTYPES = { '사실': '글에서 찾기', '추론': '짐작하기', '어휘': '낱말 뜻', '중심': '중심 생각' };
  const MAX_LEVEL = 3;
  const WINDOW = 10;   // 최근 몇 문제로 단계를 판단할지
  const PASS = 8;      // 그중 몇 개 맞히면 다음 단계로
  const KEY = 'munhae-training-v1';

  /* ---------------- 저장 ---------------- */
  function freshState() {
    const modes = {}, stats = {};
    Object.keys(MODES).forEach(m => { modes[m] = { level: 1, recent: [] }; stats[m] = { total: 0, correct: 0 }; });
    // weak: 약점 문제 { 키: { mode, miss(틀린 횟수), streak(연속 정답) } }
    return { name: '', stars: 0, streak: 0, lastDay: null, days: {}, modes, stats, qtypes: {}, weak: {}, mastered: 0, seen: {}, sessions: [] };
  }
  function load() {
    const base = freshState();
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return base;
      const s = JSON.parse(raw);
      // 새 기능이 추가돼도 예전 기록이 깨지지 않도록 합칩니다.
      Object.keys(MODES).forEach(m => {
        s.modes = s.modes || {}; s.stats = s.stats || {};
        s.modes[m] = Object.assign({}, base.modes[m], s.modes[m]);
        s.stats[m] = Object.assign({}, base.stats[m], s.stats[m]);
      });
      // 예전 버전의 wrong 기록을 weak 로 옮깁니다
      if (s.wrong) {
        s.weak = s.weak || {};
        Object.keys(s.wrong).forEach(id => {
          const mode = Object.keys(MODES).find(m => m !== 'reading' && C[m].some(x => x.id === id));
          if (mode && !s.weak[id]) s.weak[id] = { mode, miss: 1, streak: 0 };
        });
        delete s.wrong;
      }
      return Object.assign(base, s);
    } catch (e) { return base; }
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* 저장 불가 환경 */ } }

  let S = load();

  /* ---------------- 도구 ---------------- */
  const $app = document.getElementById('app');
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const k in (attrs || {})) {
      const v = attrs[k];
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    kids.flat().forEach(c => { if (c != null && c !== false) el.append(c.nodeType ? c : String(c)); });
    return el;
  }
  function screen(...kids) { $app.replaceChildren(...kids); window.scrollTo(0, 0); }
  function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
  function pickOne(a) { return a[Math.floor(Math.random() * a.length)]; }
  function dayStr(d) { d = d || new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function yesterday() { const d = new Date(); d.setDate(d.getDate() - 1); return dayStr(d); }
  function pct(c, t) { return t ? Math.round(c / t * 100) : null; }

  /* 소리 내어 읽어 주기 (기기에 한국어 음성이 있어야 해요) */
  function speak(text) {
    try {
      if (!('speechSynthesis' in window)) return;
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text.replace(/\[|\]/g, ''));
      u.lang = 'ko-KR'; u.rate = 0.85;
      const v = speechSynthesis.getVoices().find(v => v.lang && v.lang.startsWith('ko'));
      if (v) u.voice = v;
      speechSynthesis.speak(u);
    } catch (e) { }
  }
  function speakBtn(text) { return h('button', { class: 'speak', onclick: () => speak(text), title: '읽어 주기' }, '🔊 읽어 줘'); }

  let actx = null;
  function beep(good) {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const notes = good ? [660, 880] : [300, 220];
      notes.forEach((f, i) => {
        const o = actx.createOscillator(), g = actx.createGain();
        o.frequency.value = f; o.type = 'sine';
        g.gain.setValueAtTime(0.12, actx.currentTime + i * 0.12);
        g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + i * 0.12 + 0.2);
        o.connect(g); g.connect(actx.destination);
        o.start(actx.currentTime + i * 0.12); o.stop(actx.currentTime + i * 0.12 + 0.22);
      });
    } catch (e) { }
  }

  function updateTopbar() {
    document.getElementById('starCount').textContent = S.stars;
    const alive = S.lastDay === dayStr() || S.lastDay === yesterday();
    document.getElementById('streakCount').textContent = alive ? S.streak : 0;
  }

  /* ---------------- 기록 & 단계 ---------------- */
  let session = null;

  function record(mode, ok, qtype) {
    const st = S.stats[mode]; st.total++; if (ok) st.correct++;
    if (qtype) { const q = S.qtypes[qtype] = S.qtypes[qtype] || { total: 0, correct: 0 }; q.total++; if (ok) q.correct++; }
    if (ok) S.stars++;
    const md = S.modes[mode];
    md.recent.push(ok ? 1 : 0);
    if (md.recent.length > WINDOW) md.recent.shift();
    if (md.recent.length >= WINDOW && md.recent.reduce((a, b) => a + b, 0) >= PASS && md.level < MAX_LEVEL) {
      md.level++; md.recent = [];
      if (session) session.levelUps.push(mode);
    }
    if (session) { session.total++; if (ok) session.correct++; }
    const d = S.days[dayStr()] = S.days[dayStr()] || { daily: false, count: 0 };
    d.count++;
    save(); updateTopbar();
  }
  const MASTER = 2; // 약점 문제를 연속 몇 번 맞히면 '극복'으로 볼지

  /* key: 낱말·순서·이어주는 말은 문제 id, 글 읽기는 "글id#문제번호" */
  function markItem(key, ok, mode) {
    S.seen[key] = (S.seen[key] || 0) + 1;
    const w = S.weak[key];
    if (!ok) {
      S.weak[key] = { mode, miss: (w ? w.miss : 0) + 1, streak: 0 };
      if (session) session.wrongs++;
    } else if (w) {
      w.streak++;
      if (w.streak >= MASTER) { delete S.weak[key]; S.mastered = (S.mastered || 0) + 1; if (session) session.mastered++; }
    }
    save();
  }
  function isWeak(mode, it) {
    return mode === 'reading' ? it.questions.some((_, qi) => S.weak[it.id + '#' + qi]) : !!S.weak[it.id];
  }
  function weakCount() { return Object.keys(S.weak).length; }
  /* 현재 단계 문제를 모두 한 번 이상 풀었으면 '한 바퀴 완주' */
  function cycleDone(mode) {
    const lv = S.modes[mode].level;
    return C[mode].filter(it => it.level === lv).every(it => S.seen[it.id]);
  }

  /* 약점 문제 → 덜 본 문제 → 무작위 순으로 고릅니다 */
  function pick(mode, n) {
    const lv = S.modes[mode].level;
    let pool = C[mode].filter(it => it.level === lv);
    if (pool.length < n) pool = pool.concat(C[mode].filter(it => it.level < lv));
    if (pool.length < n) pool = C[mode].slice();
    return shuffle(pool)
      .map(it => ({ it, k: (isWeak(mode, it) ? 0 : 1000) + (S.seen[it.id] || 0) }))
      .sort((a, b) => a.k - b.k)
      .slice(0, n).map(x => x.it);
  }
  function levelProgress(mode) {
    const md = S.modes[mode];
    if (md.level >= MAX_LEVEL) return 1;
    return Math.min(1, md.recent.reduce((a, b) => a + b, 0) / PASS);
  }

  /* ---------------- 홈 ---------------- */
  function home() {
    session = null;
    if (!S.name) return askName();
    const today = S.days[dayStr()];
    const doneToday = today && today.daily;
    screen(
      h('h1', { class: 'hello' }, `${S.name}, 안녕! 👋`),
      h('p', { class: 'muted' }, doneToday ? '오늘의 훈련을 끝냈어요. 더 하고 싶으면 아래에서 골라요!' : '오늘도 10분만 같이 읽어 볼까요?'),
      h('button', { class: 'today' + (doneToday ? ' done' : ''), onclick: startDaily },
        h('span', { class: 'big' }, doneToday ? '✅ 오늘의 훈련 한 번 더' : '🚀 오늘의 훈련 시작'),
        h('span', null, '낱말 3 · 글 읽기 1 · 순서 1 · 이어주는 말 2')),
      weakCount() ? h('button', { class: 'today review', onclick: startReview },
        h('span', { class: 'big' }, `🔁 약점 훈련 · ${weakCount()}문제`),
        h('span', null, Object.keys(MODES).some(cycleDone)
          ? '🏁 한 바퀴 완주! 자주 틀린 문제를 모양을 바꿔서 다시 풀어요'
          : '틀린 문제를 모양을 바꿔서 다시 풀어요')) : null,
      h('div', { class: 'modes' }, Object.keys(MODES).map(m => {
        const md = S.modes[m];
        return h('button', { class: 'mode m-' + m, onclick: () => startPractice(m) },
          h('span', { class: 'ico' }, MODES[m].ico),
          h('span', { class: 'name' }, MODES[m].name),
          h('span', { class: 'lv' }, `${md.level}단계${cycleDone(m) ? ' · 🏁 완주' : ''} · ${MODES[m].desc}`),
          h('div', { class: 'bar' }, h('i', { style: `width:${Math.round(levelProgress(m) * 100)}%` })));
      })),
      h('div', { class: 'parent-link' }, h('button', { class: 'btn ghost small', onclick: parentGate }, '👨‍👩‍👧 부모님 화면')),
    );
  }

  function askName() {
    const inp = h('input', { type: 'text', placeholder: '이름을 적어 주세요', maxlength: 10 });
    const go = () => { const v = inp.value.trim(); if (!v) return inp.focus(); S.name = v; save(); home(); };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    screen(h('div', { class: 'card center pop' },
      h('div', { class: 'word-big' }, '📚'),
      h('h2', null, '반가워요! 이름이 뭐예요?'),
      inp, h('div', { class: 'spacer' }),
      h('button', { class: 'btn block', onclick: go }, '시작하기')));
    inp.focus();
  }

  /* ---------------- 세션 ---------------- */
  function startDaily() {
    const steps = [
      ...pick('vocab', 3).map(it => ({ mode: 'vocab', it })),
      ...pick('reading', 1).map(it => ({ mode: 'reading', it })),
      ...pick('order', 1).map(it => ({ mode: 'order', it })),
      ...pick('connect', 2).map(it => ({ mode: 'connect', it })),
    ];
    runSession('오늘의 훈련', steps, true);
  }
  function startPractice(mode) {
    const n = { vocab: 6, reading: 2, order: 3, connect: 5 }[mode];
    runSession(MODES[mode].name + ' 연습', pick(mode, n).map(it => ({ mode, it })), false);
  }
  function runSession(title, steps, daily, review) {
    const cyclesBefore = Object.keys(MODES).filter(cycleDone);
    session = { title, steps, i: 0, daily, review: !!review, total: 0, correct: 0, wrongs: 0, mastered: 0, cyclesBefore, starsBefore: S.stars, levelUps: [] };
    nextStep();
  }
  function nextStep() {
    if (session.i >= session.steps.length) return finish();
    const step = session.steps[session.i];
    const prog = h('div', { class: 'progress' }, session.steps.map((_, k) =>
      h('i', { class: k < session.i ? 'done' : k === session.i ? 'now' : '' })));
    const body = h('div');
    screen(prog, body);
    RENDER[step.mode](body, step.it, () => { session.i++; nextStep(); });
  }

  function tag(mode) {
    const pre = session && session.review ? '🔁 변형 문제 · ' : '';
    return h('span', { class: 'tag m-' + mode }, `${pre}${MODES[mode].ico} ${MODES[mode].name} · ${S.modes[mode].level}단계`);
  }
  const HINT = {
    '사실': '💡 정답은 글 속에 그대로 있어요. 다시 찾아볼까요?',
    '추론': '💡 글에 직접 나오진 않지만, 앞뒤 내용을 보면 짐작할 수 있어요.',
    '중심': '💡 글 전체가 무엇에 대해 말하는지 생각해 봐요.',
    '어휘': '💡 낱말 앞뒤의 문장을 보면 뜻을 알 수 있어요.',
  };

  const PRAISE = ['딩동댕! 맞았어요 🎉', '최고예요! ⭐', '훌륭해요! 👏', '척척박사네요! 🧠'];
  const CHEER = ['아쉬워요! 정답을 같이 볼까요?', '괜찮아요, 틀리면서 배우는 거예요 💪', '다시 한 번 읽어 보면 보여요 👀'];

  /* 객관식 공통: choices(문자열 배열), answer(번호) → onDone(ok) */
  function choiceBox(choices, answer, onDone) {
    const order = shuffle(choices.map((c, i) => i));
    const box = h('div', { class: 'choices' });
    const btns = order.map(i => h('button', {
      class: 'choice', onclick: () => {
        btns.forEach(b => b.disabled = true);
        const ok = i === answer;
        btns.forEach((b, k) => { if (order[k] === answer) b.classList.add('right'); });
        if (!ok) btns[order.indexOf(i)].classList.add('wrong');
        beep(ok);
        onDone(ok);
      }
    }, choices[i]));
    box.append(...btns);
    return box;
  }
  function feedback(ok, ...extra) {
    return h('div', { class: 'feedback pop ' + (ok ? 'good' : 'bad') },
      h('b', null, ok ? pickOne(PRAISE) : pickOne(CHEER)), extra.length ? h('div', null, ...extra) : null);
  }
  function nextBtn(onNext, label) {
    const b = h('button', { class: 'btn block', onclick: onNext }, label || '다음 ➜');
    setTimeout(() => b.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
    return b;
  }
  function exampleNode(ex) {
    // "[낱말]" 부분을 굵게
    const parts = ex.split(/\[|\]/);
    return h('span', null, '예) ', parts.map((p, i) => i % 2 ? h('b', null, p) : p));
  }

  /* ---------------- 영역별 화면 ---------------- */
  const RENDER = {
    vocab(root, it, next, opt) {
      opt = opt || {};
      const canBlank = sameForm(it);
      const usable = isMimetic(it) && mimeticPool(it).length >= 2;
      const types = ['meaning', 'word'].concat(canBlank ? ['blank'] : [], usable ? ['usage'] : []);
      const type = pickOne(types);
      if (type === 'usage') return vocabUsage(root, it, next, opt);
      const same = C.vocab.filter(v => v.id !== it.id && v.level === it.level);
      const others = shuffle(same.length >= 2 ? same : C.vocab.filter(v => v.id !== it.id));
      let prompt, choices, center = null;

      if (type === 'meaning') {
        center = h('div', { class: 'word-big' }, it.word);
        prompt = `'${it.word}'은(는) 무슨 뜻일까요?`;
        choices = [it.meaning, ...others.slice(0, 2).map(v => v.meaning)];
      } else if (type === 'word') {
        prompt = '이런 뜻을 가진 낱말은 무엇일까요?';
        center = h('div', { class: 'card center' }, h('span', { class: 'prompt' }, `"${it.meaning}"`));
        choices = [it.word, ...others.slice(0, 2).map(v => v.word)];
      } else {
        prompt = '빈칸에 들어갈 알맞은 낱말은?';
        const parts = it.example.split(/\[.+?\]/);
        center = h('div', { class: 'card passage' }, parts[0], h('span', { class: 'blank' }, '？'), parts[1] || '');
        // 같은 모양(바꿔 쓰지 않는 낱말)끼리만 보기로 씁니다
        choices = [it.word, ...sameFormPool(it).slice(0, 2).map(v => v.word)];
      }

      const after = h('div');
      root.append(tag('vocab'),
        h('div', { class: 'row' }, h('h2', { class: 'prompt' }, prompt), speakBtn(type === 'blank' ? it.example.replace(/\[.+?\]/, '무엇') : prompt)),
        center,
        choiceBox(choices, 0, ok => {
          record('vocab', ok); markItem(opt.key || it.id, ok, 'vocab');
          after.append(feedback(ok, h('div', null, h('b', null, it.word), ` : ${it.meaning}`), exampleNode(it.example)), h('div', { class: 'spacer' }), nextBtn(next));
        }),
        after);
    },

    reading(root, it, next) {
      let qi = 0;
      const qArea = h('div');
      const readBtn = h('button', { class: 'btn block', onclick: () => { readBtn.remove(); askQ(); } }, '다 읽었어요! 문제 풀기 ➜');
      root.append(tag('reading'),
        h('div', { class: 'card' },
          h('div', { class: 'row', style: 'justify-content:space-between' }, h('h2', { class: 'passage-title' }, it.title), speakBtn(it.title + '. ' + it.text)),
          h('div', { class: 'passage' }, it.text)),
        readBtn, qArea);

      function askQ() {
        const q = it.questions[qi];
        const after = h('div');
        const card = h('div', { class: 'card pop' },
          h('p', { class: 'muted' }, `문제 ${qi + 1} / ${it.questions.length} · ${QTYPES[q.type] || q.type}`),
          h('div', { class: 'row' }, h('h3', { class: 'prompt' }, q.q), speakBtn(q.q)),
          choiceBox(q.choices, q.answer, ok => {
            record('reading', ok, q.type); markItem(it.id + '#' + qi, ok, 'reading');
            const hint = ok ? null : HINT[q.type];
            qi++;
            const last = qi >= it.questions.length;
            after.append(feedback(ok, hint), h('div', { class: 'spacer' }),
              nextBtn(() => { if (last) { S.seen[it.id] = (S.seen[it.id] || 0) + 1; save(); next(); } else { after.querySelector('button.btn').remove(); askQ(); } }, last ? '다음 ➜' : '다음 문제 ➜'));
          }),
          after);
        qArea.append(card);
        setTimeout(() => card.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
      }
    },

    order(root, it, next, opt) {
      opt = opt || {};
      const placed = [];
      let pool = shuffle(it.sentences.map((s, i) => i));
      // 우연히 정답 순서로 섞이면 다시 섞기
      while (pool.length > 1 && pool.every((v, k) => v === k)) pool = shuffle(pool);
      const slots = h('div', { class: 'slots' });
      const poolBox = h('div', { class: 'pool' });
      const check = h('button', { class: 'btn block', disabled: true, onclick: grade }, '확인하기');
      const after = h('div');
      let locked = false;

      function draw() {
        slots.replaceChildren(...(placed.length ? placed.map((idx, k) =>
          h('button', { class: 'slot', onclick: () => { if (locked) return; placed.splice(k, 1); pool.push(idx); draw(); } },
            h('span', { class: 'n' }, k + 1), it.sentences[idx]))
          : [h('span', { class: 'muted' }, '아래 문장을 먼저 일어난 일부터 차례로 눌러요')]));
        poolBox.replaceChildren(...pool.map((idx, k) =>
          h('button', { class: 'choice', onclick: () => { if (locked) return; pool.splice(k, 1); placed.push(idx); draw(); } }, it.sentences[idx])));
        check.disabled = pool.length > 0;
      }
      function grade() {
        locked = true; check.remove();
        const ok = placed.every((v, k) => v === k);
        [...slots.children].forEach((el, k) => el.classList.add(placed[k] === k ? 'right' : 'wrong'));
        beep(ok); record('order', ok); markItem(opt.key || it.id, ok, 'order');
        after.append(feedback(ok, ok ? null : h('ol', null, it.sentences.map(s => h('li', null, s)))), h('div', { class: 'spacer' }), nextBtn(next));
      }
      root.append(tag('order'),
        h('h2', { class: 'prompt' }, `「${it.title}」 순서대로 놓아 볼까요?`),
        slots, poolBox, h('div', { class: 'spacer' }), check, after);
      draw();
    },

    connect(root, it, next, opt) {
      opt = opt || {};
      const [a, b] = it.sentence.split('___');
      const blankEl = h('span', { class: 'blank' }, '？');
      const after = h('div');
      root.append(tag('connect'),
        h('div', { class: 'row' }, h('h2', { class: 'prompt' }, '빈칸에 알맞은 이어주는 말은?'), speakBtn(it.sentence.replace('___', ', 음, '))),
        h('div', { class: 'card passage' }, a, blankEl, b || ''),
        choiceBox(it.choices, it.answer, ok => {
          blankEl.textContent = it.choices[it.answer];
          record('connect', ok); markItem(opt.key || it.id, ok, 'connect');
          after.append(feedback(ok, it.why), h('div', { class: 'spacer' }), nextBtn(next));
        }),
        after);
    },
  };

  /* =========================================================
   * 변형 문제 (약점 훈련)
   * 틀린 문제를 그대로 다시 내지 않고, 같은 힘을 묻는 다른 모양으로 바꿔 냅니다.
   * ========================================================= */
  function sameForm(v) { const m = v.example.match(/\[(.+?)\]/); return !!m && m[1] === v.word; }
  function sameFormPool(v) { return shuffle(C.vocab.filter(x => x.id !== v.id && sameForm(x))); }
  // '살금살금'처럼 같은 말이 되풀이되는 흉내말 — 다른 문장에 넣으면 확실히 어색해서 '바르게 쓴 문장' 문제에 씁니다
  function isMimetic(v) { const w = v.word; return sameForm(v) && w.length === 4 && w.slice(0, 2) === w.slice(2); }
  function mimeticPool(v) { return shuffle(C.vocab.filter(x => x.id !== v.id && isMimetic(x))); }
  const fill = (ex, word) => ex.replace(/\[.+?\]/, word);

  /* 공통 객관식 화면 */
  function mcq(root, o, next) {
    const after = h('div');
    const head = h('div', { class: 'row' }, h('h2', { class: 'prompt' }, o.prompt), speakBtn(o.speak || o.prompt));
    root.append(tag(o.mode), ...(o.centerFirst ? [o.center, head] : [head, o.center || '']),
      choiceBox(o.choices, o.answer, ok => {
        record(o.mode, ok, o.qtype); markItem(o.key, ok, o.mode);
        after.append(feedback(ok, ...[].concat(o.explain || [])), h('div', { class: 'spacer' }), nextBtn(next));
      }),
      after);
  }

  /* 낱말: 알맞게 쓴 문장 고르기 */
  function vocabUsage(root, it, next, opt) {
    mcq(root, {
      mode: 'vocab', key: (opt && opt.key) || it.id,
      prompt: `'${it.word}'을(를) 알맞게 쓴 문장은?`,
      center: h('div', { class: 'word-big' }, it.word),
      choices: [fill(it.example, it.word), ...mimeticPool(it).slice(0, 2).map(v => fill(v.example, it.word))], answer: 0,
      explain: [h('div', null, h('b', null, it.word), ` : ${it.meaning}`), exampleNode(it.example)],
    }, next);
  }

  /* 순서: ① 다음에 일어날 일 고르기 ② 둘 중 먼저 일어난 일 ③ 처음부터 다시 맞추기 */
  function orderVariant(root, it, next, key) {
    const s = it.sentences;
    const whole = h('ol', null, s.map(x => h('li', null, x)));
    const kind = pickOne(['next', 'first', 'full']);
    if (kind === 'full') return RENDER.order(root, it, next, { key });
    if (kind === 'first') {
      const [a, b] = shuffle(s.map((_, i) => i)).slice(0, 2).sort((x, y) => x - y);
      return mcq(root, { mode: 'order', key, prompt: `「${it.title}」 둘 중 먼저 일어난 일은?`, choices: [s[a], s[b]], answer: 0, explain: whole }, next);
    }
    const m = 1 + Math.floor(Math.random() * (s.length - 2)); // 뒤에 문장이 하나 이상 남도록
    const later = shuffle(s.slice(m + 1)).slice(0, 2);
    const filler = shuffle(C.order.filter(o => o.id !== it.id).flatMap(o => o.sentences)).slice(0, 2 - later.length);
    mcq(root, {
      mode: 'order', key, prompt: `「${it.title}」 그다음에 일어날 일은?`,
      center: h('div', { class: 'slots' }, s.slice(0, m).map((x, k) => h('div', { class: 'slot' }, h('span', { class: 'n' }, k + 1), x)),
        h('div', { class: 'slot' }, h('span', { class: 'n' }, m + 1), h('span', { class: 'blank' }, '？'))),
      choices: [s[m], ...later, ...filler], answer: 0, explain: whole,
    }, next);
  }

  /* 이어주는 말: ① 같은 말이 들어가는 다른 문장 ② 그 말이 자연스러운 문장 고르기 */
  const REL = { '그래서': '결과', '그 결과': '결과', '하지만': '반대', '그러나': '반대', '반면에': '반대', '그런데': '반대',
    '그리고': '이어서', '게다가': '이어서', '그다음에': '이어서', '그런 다음': '이어서', '그러자': '이어서',
    '왜냐하면': '까닭', '알고 보니': '까닭', '예를 들면': '예시', '다행히': '다행' };
  // 서로 바꿔 넣어도 말이 될 수 있는 묶음끼리는 오답 보기로 섞지 않습니다
  const CLASH = { '결과': ['이어서'], '반대': ['이어서'], '이어서': ['결과', '반대'] };
  const PICKABLE = ['그래서', '그 결과', '하지만', '그러나', '반면에', '왜냐하면', '예를 들면'];
  function connectVariant(root, it, next, key) {
    const ans = c => c.choices[c.answer];
    const W = ans(it), g = REL[W] || W;
    const sameWord = C.connect.filter(c => c.id !== it.id && ans(c) === W);
    const diff = shuffle(C.connect.filter(c => { const g2 = REL[ans(c)] || ans(c); return g2 !== g && !(CLASH[g] || []).includes(g2); }));
    const canPick = PICKABLE.includes(W) && diff.length >= 2;
    if (sameWord.length && (!canPick || Math.random() < 0.5)) return RENDER.connect(root, pickOne(sameWord), next, { key });
    if (!canPick) return RENDER.connect(root, it, next, { key });
    const right = sameWord.length ? pickOne(sameWord) : it;
    const put = c => c.sentence.replace('___', W);
    mcq(root, {
      mode: 'connect', key, prompt: `'${W}' — 알맞게 쓰인 문장을 골라요`,
      choices: [put(right), put(diff[0]), put(diff[1])], answer: 0, explain: it.why,
    }, next);
  }

  /* 글 읽기: 틀린 문제와 같은 유형(사실·추론·어휘·중심)의 문제를 다른 글에서 냅니다 */
  function readingVariant(root, key, next) {
    const [rid, qi] = key.split('#');
    const src = C.reading.find(r => r.id === rid);
    const oq = src && src.questions[Number(qi)];
    if (!oq) { delete S.weak[key]; save(); return next(); }
    const maxLv = Math.max(S.modes.reading.level, src.level);
    const cands = [];
    C.reading.forEach(r => {
      if (r.id === rid || r.level > maxLv) return;
      r.questions.forEach((q, i) => { if (q.type === oq.type) cands.push({ r, q, k: r.id + '#' + i }); });
    });
    const c = cands.length ? shuffle(cands).sort((a, b) => (S.seen[a.k] || 0) - (S.seen[b.k] || 0))[0] : { r: src, q: oq, k: key };
    if (c.k !== key) S.seen[c.k] = (S.seen[c.k] || 0) + 1;
    mcq(root, {
      mode: 'reading', key, qtype: oq.type, centerFirst: true,
      prompt: c.q.q,
      center: h('div', { class: 'card' },
        h('p', { class: 'muted' }, `'${QTYPES[oq.type]}' 문제를 한 번 더 연습해요`),
        h('div', { class: 'row', style: 'justify-content:space-between' }, h('h2', { class: 'passage-title' }, c.r.title), speakBtn(c.r.title + '. ' + c.r.text)),
        h('div', { class: 'passage' }, c.r.text)),
      choices: c.q.choices, answer: c.q.answer, explain: HINT[oq.type],
    }, next);
  }

  RENDER.review = function (root, step, next) {
    const { key, mode } = step;
    if (mode === 'reading') return readingVariant(root, key, next);
    const it = C[mode] && C[mode].find(x => x.id === key);
    if (!it) { delete S.weak[key]; save(); return next(); }
    if (mode === 'vocab') return RENDER.vocab(root, it, next, { key });
    if (mode === 'order') return orderVariant(root, it, next, key);
    if (mode === 'connect') return connectVariant(root, it, next, key);
    next();
  };

  /* 많이 틀린 순서로 최대 8개를 골라 변형 문제로 냅니다 */
  function startReview() {
    const keys = Object.keys(S.weak).sort((a, b) => S.weak[b].miss - S.weak[a].miss).slice(0, 8);
    if (!keys.length) return home();
    runSession('약점 훈련', shuffle(keys).map(k => ({ mode: 'review', it: { key: k, mode: S.weak[k].mode } })), false, true);
  }

  function describeWeak(key) {
    const w = S.weak[key];
    if (w.mode === 'reading') {
      const [rid, qi] = key.split('#'); const r = C.reading.find(x => x.id === rid); const q = r && r.questions[Number(qi)];
      return q ? `「${r.title}」 ${q.type} 문제` : key;
    }
    const it = (C[w.mode] || []).find(x => x.id === key);
    if (!it) return key;
    return w.mode === 'vocab' ? it.word : w.mode === 'order' ? `「${it.title}」` : `'${it.choices[it.answer]}' 넣기`;
  }

  /* ---------------- 결과 ---------------- */
  function finish() {
    const s = session;
    const today = dayStr();
    if (S.lastDay !== today) { S.streak = S.lastDay === yesterday() ? S.streak + 1 : 1; S.lastDay = today; }
    const d = S.days[today] = S.days[today] || { daily: false, count: 0 };
    if (s.daily) d.daily = true;
    S.sessions.push({ at: new Date().toISOString(), title: s.title, total: s.total, correct: s.correct });
    if (S.sessions.length > 200) S.sessions = S.sessions.slice(-200);
    save(); updateTopbar();

    const rate = s.total ? s.correct / s.total : 0;
    const stars = rate >= 0.9 ? 3 : rate >= 0.6 ? 2 : 1;
    const newCycles = Object.keys(MODES).filter(m => cycleDone(m) && !s.cyclesBefore.includes(m));
    const nWeak = weakCount();
    let reviewBox = null;
    if (s.review) {
      reviewBox = h('div', { class: 'levelup' }, s.mastered ? `💪 약점 ${s.mastered}개를 이겨 냈어요!` : '조금씩 나아지고 있어요!',
        h('div', { class: 'muted' }, nWeak ? `남은 약점 문제 ${nWeak}개 · 연속 ${MASTER}번 맞히면 사라져요` : '남은 약점 문제가 없어요 🎉'));
    } else if (nWeak && (s.wrongs || newCycles.length)) {
      reviewBox = h('div', { class: 'levelup' },
        newCycles.length ? `🏁 ${newCycles.map(m => MODES[m].name).join(', ')} 한 바퀴 다 풀었어요!` : '틀린 문제가 있었어요.',
        h('div', { class: 'muted' }, '틀린 문제를 모양을 바꿔서 다시 풀어 볼까요?'), h('div', { class: 'spacer' }),
        h('button', { class: 'btn block review-btn', onclick: startReview }, `🔁 약점 훈련 (${Math.min(nWeak, 8)}문제)`));
    }
    screen(h('div', { class: 'card center pop' },
      h('div', { class: 'result-stars' }, '⭐'.repeat(stars) + '☆'.repeat(3 - stars)),
      h('h2', null, rate >= 0.9 ? '완벽해요!' : rate >= 0.6 ? '잘했어요!' : '끝까지 해낸 게 멋져요!'),
      h('p', null, `${s.total}문제 중 ${s.correct}개 맞혔어요. 별 ${S.stars - s.starsBefore}개를 모았어요!`),
      h('p', { class: 'muted' }, `🔥 ${S.streak}일째 연속으로 공부하고 있어요`),
      s.levelUps.map(m => h('div', { class: 'levelup' }, `🎊 ${MODES[m].name} ${S.modes[m].level}단계로 올라갔어요!`)),
      reviewBox,
      h('div', { class: 'spacer' }),
      h('button', { class: reviewBox && !s.review ? 'btn ghost block' : 'btn block', onclick: home }, '처음으로')));
  }

  /* ---------------- 부모님 화면 ---------------- */
  function parentGate() {
    const a = 6 + Math.floor(Math.random() * 4), b = 6 + Math.floor(Math.random() * 4);
    const inp = h('input', { type: 'number', inputmode: 'numeric', placeholder: '답' });
    const msg = h('p', { class: 'muted' });
    const go = () => { if (Number(inp.value) === a * b) parent(); else { msg.textContent = '답이 달라요.'; inp.value = ''; } };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    screen(h('div', { class: 'card' },
      h('h2', null, '부모님 확인'),
      h('p', null, `${a} × ${b} = ?`), inp, msg,
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: go }, '들어가기'), h('button', { class: 'btn ghost', onclick: home }, '돌아가기'))));
    inp.focus();
  }

  function parent() {
    const rateTxt = (c, t) => t ? `${pct(c, t)}% (${c}/${t})` : '-';

    const modeTable = h('table', null,
      h('tr', null, h('th', null, '영역'), h('th', null, '단계'), h('th', null, '정답률'), h('th', null, '단계 조정')),
      Object.keys(MODES).map(m => {
        const sel = h('select', { onchange: e => { S.modes[m].level = Number(e.target.value); S.modes[m].recent = []; save(); } },
          [1, 2, 3].map(l => h('option', { value: l, selected: S.modes[m].level === l }, l + '단계')));
        return h('tr', null, h('td', null, MODES[m].ico + ' ' + MODES[m].name), h('td', null, S.modes[m].level),
          h('td', null, rateTxt(S.stats[m].correct, S.stats[m].total)), h('td', null, sel));
      }));

    const qt = Object.keys(QTYPES).map(k => ({ k, ...(S.qtypes[k] || { total: 0, correct: 0 }) }));
    const weak = qt.filter(x => x.total >= 5).sort((a, b) => a.correct / a.total - b.correct / b.total)[0];
    const advice = {
      '사실': '글에 나온 내용을 찾는 연습이 더 필요해요. 읽은 뒤 "누가, 언제, 어디서, 무엇을?"을 말로 물어봐 주세요.',
      '추론': '글에 직접 쓰이지 않은 것을 짐작하는 힘을 키울 때예요. "왜 그랬을까?", "기분이 어땠을까?"를 자주 물어봐 주세요.',
      '어휘': '낱말 뜻을 앞뒤 문장으로 짐작하는 연습이 필요해요. 모르는 낱말이 나오면 바로 알려 주기보다 먼저 짐작해 보게 해 주세요.',
      '중심': '글 전체를 한 문장으로 요약하는 연습이 좋아요. "이 글은 무엇에 대한 이야기야?"를 물어봐 주세요.',
    };
    const typeTable = h('table', null,
      h('tr', null, h('th', null, '문제 유형'), h('th', null, '정답률')),
      qt.map(x => h('tr', null, h('td', null, `${x.k} (${QTYPES[x.k]})`), h('td', null, rateTxt(x.correct, x.total)))));

    const weakKeys = Object.keys(S.weak).sort((a, b) => S.weak[b].miss - S.weak[a].miss);
    const weakTable = weakKeys.length ? h('table', null,
      h('tr', null, h('th', null, '문제'), h('th', null, '영역'), h('th', null, '틀린 횟수'), h('th', null, '극복까지')),
      weakKeys.slice(0, 15).map(k => h('tr', null, h('td', null, describeWeak(k)), h('td', null, MODES[S.weak[k].mode].name),
        h('td', null, S.weak[k].miss + '번'), h('td', null, `${S.weak[k].streak}/${MASTER}`))))
      : h('p', null, '지금은 약점 문제가 없어요. 👍');

    const cal = h('div', { class: 'cal' });
    for (let i = 27; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const k = dayStr(d), on = S.days[k] && S.days[k].count > 0;
      cal.append(h('div', { class: on ? 'on' : '', title: k }, d.getDate()));
    }
    const studied = Object.values(S.days).filter(d => d.count > 0).length;

    const recent = S.sessions.slice(-8).reverse();
    const nameInp = h('input', { type: 'text', value: S.name, maxlength: 10 });
    const file = h('input', { type: 'file', accept: '.json,application/json', style: 'display:none', onchange: importData });

    screen(
      h('h1', null, '👨‍👩‍👧 부모님 화면'),
      h('div', { class: 'card' }, h('h3', null, '📅 최근 4주 학습'), cal,
        h('p', { class: 'muted' }, `지금까지 ${studied}일 공부했어요 · 연속 ${S.streak}일 · 별 ${S.stars}개`)),
      h('div', { class: 'card' }, h('h3', null, '📊 영역별 현황'), modeTable,
        h('p', { class: 'muted' }, `최근 ${WINDOW}문제 중 ${PASS}개 이상 맞히면 자동으로 다음 단계로 올라가요.`)),
      h('div', { class: 'card' }, h('h3', null, '🔍 글 읽기 – 어떤 생각이 약할까?'), typeTable,
        h('p', null, weak ? `💬 ${advice[weak.k]}` : h('span', { class: 'muted' }, '유형마다 5문제 이상 풀면 맞춤 조언이 나와요.'))),
      h('div', { class: 'card' }, h('h3', null, '🔁 약점 문제'), weakTable,
        weakKeys.length > 15 ? h('p', { class: 'muted' }, `외 ${weakKeys.length - 15}개`) : null,
        h('p', { class: 'muted' }, `틀린 문제는 '약점 훈련'에서 모양을 바꿔 다시 나와요. 연속 ${MASTER}번 맞히면 극복! 지금까지 극복한 문제 ${S.mastered || 0}개.`)),
      h('div', { class: 'card' }, h('h3', null, '🕒 최근 기록'),
        recent.length ? h('table', null, recent.map(r => h('tr', null,
          h('td', null, new Date(r.at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })),
          h('td', null, r.title), h('td', null, `${r.correct}/${r.total}`)))) : h('p', { class: 'muted' }, '아직 기록이 없어요.')),
      h('div', { class: 'card' }, h('h3', null, '⚙️ 설정'),
        h('p', { class: 'muted' }, '아이 이름'), nameInp, h('div', { class: 'spacer' }),
        h('div', { class: 'row' },
          h('button', { class: 'btn small', onclick: () => { const v = nameInp.value.trim(); if (v) { S.name = v; save(); alert('저장했어요.'); } } }, '이름 저장'),
          h('button', { class: 'btn ghost small', onclick: exportData }, '💾 기록 백업'),
          h('button', { class: 'btn ghost small', onclick: () => file.click() }, '📂 백업 불러오기'),
          h('button', { class: 'btn ghost small', onclick: resetAll }, '🗑 기록 초기화')),
        h('p', { class: 'muted' }, '기록은 이 브라우저에만 저장돼요. 브라우저 데이터를 지우거나 기기를 바꾸기 전에 백업해 두세요.'),
        file),
      h('button', { class: 'btn block', onclick: home }, '아이 화면으로'),
    );
  }

  function exportData() {
    const blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `문해력기록_${dayStr()}.json` });
    document.body.append(a); a.click(); a.remove();
  }
  function importData(e) {
    const f = e.target.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const data = JSON.parse(r.result);
        if (!data.modes || !data.stats) throw new Error('형식 오류');
        if (!confirm('지금 기록을 백업 파일 내용으로 바꿀까요?')) return;
        localStorage.setItem(KEY, JSON.stringify(data)); S = load(); updateTopbar(); parent();
        alert('불러왔어요.');
      } catch (err) { alert('백업 파일을 읽을 수 없어요.'); }
    };
    r.readAsText(f);
  }
  function resetAll() {
    if (!confirm('모든 학습 기록을 지울까요? 되돌릴 수 없어요.')) return;
    S = freshState(); save(); updateTopbar(); home();
  }

  /* ---------------- 시작 ---------------- */
  document.getElementById('homeBtn').addEventListener('click', () => {
    if (session && session.i < session.steps.length && session.total > 0 && !confirm('훈련을 그만하고 처음으로 갈까요?')) return;
    home();
  });
  if ('speechSynthesis' in window) speechSynthesis.getVoices(); // 음성 목록 미리 불러오기
  updateTopbar();
  home();
})();
