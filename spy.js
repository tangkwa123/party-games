// ใครคือสายลับ? — host-authoritative party game.
// The host's phone keeps the full state and sends each player only what they may see
// (the spy never receives the location).
(() => {
  const LOCS = SPY_DATA.locations;
  const QUESTIONS = SPY_DATA.questions;
  const MIN_PLAYERS = 4;
  const $app = document.getElementById('app');
  const $modal = document.getElementById('modal');
  const qs = new URLSearchParams(location.search);

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const pick = a => a[Math.floor(Math.random() * a.length)];
  const locName = i => LOCS[i][0] + ' ' + LOCS[i][1];

  const me = JSON.parse(localStorage.getItem('spy.me') || 'null') || { id: rid(), name: '' };
  const saveMe = () => localStorage.setItem('spy.me', JSON.stringify(me));
  saveMe();

  let V = null;          // latest view of the game (from host, or built locally when hosting)
  let net = null;
  let isHost = false;
  let code = null;
  let status = 'idle';   // idle | connecting | open | lost | reclaim
  let resumeTries = 0;
  const ui = { reveal: false, struck: {}, round: 0, modal: null, guess: null, idea: null };

  // ---------------------------------------------------------------- host engine
  let S = null;
  const connToPlayer = new Map();

  const P = id => S.players.find(p => p.id === id);
  const nm = id => (P(id) || { name: '?' }).name;
  const inRound = id => !!(S.round && S.round.players.includes(id));
  const cleanName = n => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 16);

  function uniqName(name, id) {
    let n = name, i = 2;
    while (S.players.some(p => p.id !== id && p.name === n)) n = name + ' ' + (i++);
    return n;
  }
  function addPlayer(id, name) {
    name = cleanName(name) || 'ผู้เล่น';
    const p = P(id);
    if (p) { p.connected = true; p.name = uniqName(name, id); return true; }
    if (S.players.length >= 20) return false;
    S.players.push({ id, name: uniqName(name, id), connected: true, score: 0 });
    return true;
  }
  function timeLeft() {
    const r = S.round;
    if (!r) return 0;
    return r.paused ? r.left : Math.max(0, r.endAt - Date.now());
  }
  function pause() { const r = S.round; if (!r.paused) { r.left = timeLeft(); r.paused = true; } }
  function resume() { const r = S.round; if (r.paused) { r.endAt = Date.now() + r.left; r.paused = false; } }
  function log(text) { S.round.log.push(text); }

  function view(id) {
    const v = {
      code: S.code, phase: S.phase, me: id, hostId: S.hostId, minutes: S.minutes,
      players: S.players.map(p => ({ id: p.id, name: p.name, connected: p.connected, score: p.score })),
      round: null,
    };
    const r = S.round;
    if (r) {
      const ended = S.phase === 'result';
      const playing = r.players.includes(id);
      const vt = r.vote;
      v.round = {
        n: r.n, players: r.players, playing,
        spy: playing && id === r.spy,
        loc: (ended || (playing && id !== r.spy)) ? r.loc : null,
        spyId: ended ? r.spy : null,
        asker: r.asker, target: r.target,
        timeLeft: timeLeft(), paused: r.paused,
        log: r.log.slice(-40),
        vote: vt && {
          caller: vt.caller, final: vt.final, candidates: vt.candidates, tie: vt.tie,
          voted: Object.keys(vt.votes), myVote: vt.votes[id] || null,
          counts: ended ? vt.counts || null : null,
        },
        result: r.result,
      };
    }
    return v;
  }

  function broadcast() {
    if (!S) return;
    for (const [connId, pid] of connToPlayer) net.send(connId, { t: 'state', v: view(pid) });
    localStorage.setItem('spy.host.' + S.code, JSON.stringify(S));
    receive(view(me.id));
  }
  function tell(pid, text) {
    if (pid === me.id) return toast(text);
    for (const [connId, p] of connToPlayer) if (p === pid) net.send(connId, { t: 'toast', text });
  }

  function startRound(by) {
    const players = S.players.filter(p => p.connected).map(p => p.id);
    if (players.length < MIN_PLAYERS) return tell(by, `ต้องมีผู้เล่นออนไลน์อย่างน้อย ${MIN_PLAYERS} คน`);
    let choices = LOCS.map((_, i) => i).filter(i => !S.recent.includes(i));
    const loc = pick(choices);
    S.recent = [loc, ...S.recent].slice(0, 10);
    const spy = pick(players);
    const first = pick(players);
    S.round = {
      n: ++S.n, players, loc, spy, asker: first, target: null,
      endAt: Date.now() + S.minutes * 60000, left: 0, paused: false,
      log: [], vote: null, result: null,
    };
    S.phase = 'playing';
    log(`🎲 สุ่มได้ ${nm(first)} เป็นคนเริ่มถาม`);
  }

  function finish(winner, reason, extra) {
    const r = S.round;
    pause();
    r.result = Object.assign({ winner, reason }, extra || {});
    if (winner === 'spy') { const p = P(r.spy); if (p) p.score += 2; }
    else r.players.forEach(id => { if (id !== r.spy) { const p = P(id); if (p) p.score += 1; } });
    S.phase = 'result';
  }

  function checkVotes() {
    const r = S.round;
    if (S.phase !== 'voting') return;
    const voters = r.players.filter(id => P(id) && P(id).connected);
    if (voters.length && voters.every(id => r.vote.votes[id])) tally();
  }

  function tally(by) {
    const r = S.round, vt = r.vote;
    const counts = {};
    Object.values(vt.votes).forEach(t => counts[t] = (counts[t] || 0) + 1);
    const ids = Object.keys(counts);
    if (!ids.length) return by && tell(by, 'ยังไม่มีใครโหวตเลย');
    const max = Math.max(...ids.map(i => counts[i]));
    const tops = ids.filter(i => counts[i] === max);
    vt.counts = counts;
    if (tops.length > 1) {
      if (!vt.tie) {
        vt.tie = true; vt.candidates = tops; vt.votes = {};
        log(`⚖️ คะแนนเสมอ! โหวตใหม่เฉพาะ ${tops.map(nm).join(', ')}`);
        return;
      }
      log('⚖️ เสมออีกรอบ จับสายลับไม่ได้');
      return finish('spy', 'tie');
    }
    const accused = tops[0];
    log(`🗳️ ส่วนใหญ่โหวต ${nm(accused)}`);
    if (accused === r.spy) finish('agents', 'caught', { accused });
    else finish('spy', 'wrong', { accused });
  }

  function handle(pid, a) {
    if (qs.has('debug')) console.log('ACT', pid, JSON.stringify(a), S.phase);
    const r = S.round;
    const isH = pid === S.hostId;
    switch (a.t) {
      case 'minutes':
        if (isH && (S.phase === 'lobby' || S.phase === 'result')) S.minutes = Math.min(10, Math.max(3, +a.v || 6));
        break;
      case 'start':
        if (isH && (S.phase === 'lobby' || S.phase === 'result')) startRound(pid);
        break;
      case 'lobby':
        if (isH && S.phase === 'result') S.phase = 'lobby';
        break;
      case 'ask':
        if (S.phase === 'playing' && pid === r.asker && !r.target && inRound(a.target) && a.target !== pid) {
          r.target = a.target;
          log(`❓ ${nm(pid)} ถาม ${nm(a.target)}`);
        }
        break;
      case 'answered':
        if (S.phase === 'playing' && r.target && (pid === r.target || isH)) { r.asker = r.target; r.target = null; }
        break;
      case 'callVote':
        if (S.phase === 'playing' && inRound(pid)) {
          pause();
          r.vote = { caller: pid, final: false, candidates: null, votes: {}, tie: false };
          S.phase = 'voting';
          log(`🗳️ ${nm(pid)} เรียกโหวตจับสายลับ`);
        }
        break;
      case 'cancelVote':
        if (S.phase === 'voting' && !r.vote.final && !r.vote.tie && (pid === r.vote.caller || isH)) {
          r.vote = null; S.phase = 'playing'; resume();
          log(`↩️ ${nm(pid)} ยกเลิกการโหวต เล่นต่อ`);
        }
        break;
      case 'vote': {
        if (S.phase !== 'voting' || !inRound(pid) || a.target === pid) break;
        const allowed = r.vote.candidates || r.players;
        if (!allowed.includes(a.target)) break;
        r.vote.votes[pid] = a.target;
        checkVotes();
        break;
      }
      case 'tally':
        if (isH && S.phase === 'voting') tally(pid);
        break;
      case 'guess':
        if ((S.phase === 'playing' || S.phase === 'voting') && pid === r.spy && LOCS[a.loc]) {
          log(`🎯 ${nm(pid)} เปิดตัวเป็นสายลับ และทายว่า ${locName(a.loc)}`);
          if (+a.loc === r.loc) finish('spy', 'guessRight', { guess: +a.loc });
          else finish('agents', 'guessWrong', { guess: +a.loc });
        }
        break;
      case 'kick':
        if (isH && a.target !== S.hostId && S.phase !== 'playing' && S.phase !== 'voting') {
          for (const [connId, p] of connToPlayer) if (p === a.target) {
            net.send(connId, { t: 'kicked' });
            connToPlayer.delete(connId);
            setTimeout(() => net.kick(connId), 400);
          }
          S.players = S.players.filter(p => p.id !== a.target);
        }
        break;
      case 'leave':
        if (!inRound(pid) || S.phase === 'lobby' || S.phase === 'result') S.players = S.players.filter(p => p.id !== pid);
        else { const p = P(pid); if (p) p.connected = false; }
        checkVotes();
        break;
      default: return;
    }
    broadcast();
  }

  function startHost(existing) {
    isHost = true;
    if (existing) {
      S = existing;
      S.players.forEach(p => p.connected = p.id === me.id);
    } else {
      S = { code: PartyNet.newCode(), phase: 'lobby', hostId: me.id, minutes: 6, players: [], round: null, n: 0, recent: [] };
      addPlayer(me.id, me.name);
    }
    code = S.code;
    localStorage.setItem('spy.session', JSON.stringify({ code, host: true, t: Date.now() }));
    status = 'connecting';
    net = PartyNet.host('spy', code, {
      onOpen() { status = 'open'; broadcast(); },
      onData(connId, m) {
        if (!m) return;
        if (m.t === 'hello' && m.id) {
          for (const [c, p] of [...connToPlayer]) if (p === m.id && c !== connId) { connToPlayer.delete(c); net.kick(c); }
          if (!addPlayer(m.id, m.name)) { net.send(connId, { t: 'toast', text: 'ห้องเต็มแล้ว' }); return; }
          connToPlayer.set(connId, m.id);
          broadcast();
        } else if (m.t === 'act' && connToPlayer.has(connId)) {
          handle(connToPlayer.get(connId), m.a || {});
        }
      },
      onClose(connId) {
        const pid = connToPlayer.get(connId);
        connToPlayer.delete(connId);
        if (pid && ![...connToPlayer.values()].includes(pid)) {
          const p = P(pid); if (p) p.connected = false;
          if (S.round) checkVotes();
          broadcast();
        }
      },
      onError(t) {
        if (t === 'waiting-id') { status = 'reclaim'; render(); }
        else if (t === 'network' || t === 'server-error' || t === 'socket-error') { toast('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กำลังลองใหม่…'); }
      },
    });
    // the host's phone also runs the clock
    setInterval(() => {
      const r = S.round;
      if (S.phase === 'playing' && r && !r.paused && Date.now() >= r.endAt) {
        pause(); r.left = 0;
        r.vote = { caller: null, final: true, candidates: null, votes: {}, tie: false };
        S.phase = 'voting';
        log('⏰ หมดเวลา! โหวตรอบสุดท้าย');
        broadcast();
      }
    }, 500);
    receive(view(me.id));
  }

  // ---------------------------------------------------------------- player side
  function act(a) {
    if (qs.has('debug')) console.log('ACT-SEND', me.name, JSON.stringify(a), !!(net && net.connected));
    if (isHost) return handle(me.id, a);
    if (!net || !net.send({ t: 'act', a })) toast('ยังไม่ได้เชื่อมต่อ ลองอีกครั้งนะ');
  }

  function startJoin(c, resuming) {
    isHost = false;
    code = c.toUpperCase();
    status = 'connecting';
    localStorage.setItem('spy.session', JSON.stringify({ code, host: false, t: Date.now() }));
    render();
    net = PartyNet.join('spy', code, {
      onOpen() { status = 'open'; resumeTries = 0; net.send({ t: 'hello', id: me.id, name: me.name }); render(); },
      onData(m) {
        if (m.t === 'state') receive(m.v);
        else if (m.t === 'toast') toast(m.text);
        else if (m.t === 'kicked') { leave(true); toast('คุณถูกเชิญออกจากห้อง'); }
      },
      onClose() { status = 'lost'; render(); },
      onError(t) {
        if (t === 'no-room') {
          if (resuming && resumeTries++ < 15) { net.destroy(); setTimeout(() => startJoin(code, true), 3000); return; }
          net.destroy(); net = null; V = null; status = 'idle';
          localStorage.removeItem('spy.session');
          toast(`ไม่พบห้อง ${code} ลองเช็กรหัสอีกครั้ง`);
          render();
        } else if (t === 'host-gone') { status = 'lost'; render(); }
      },
    });
  }

  function leave(silent) {
    if (!silent && isHost && !confirm('ออกจากห้อง? ห้องจะถูกปิดและทุกคนจะหลุดจากเกม')) return;
    if (!isHost && net) net.send({ t: 'act', a: { t: 'leave' } });
    setTimeout(() => { if (net) net.destroy(); net = null; }, 200);
    if (isHost && S) localStorage.removeItem('spy.host.' + S.code);
    localStorage.removeItem('spy.session');
    V = null; S = null; isHost = false; status = 'idle';
    history.replaceState(null, '', location.pathname + keepParams());
    render();
  }

  function keepParams() {
    const p = new URLSearchParams(location.search); p.delete('room');
    const s = p.toString(); return s ? '?' + s : '';
  }
  function inviteLink() {
    const p = new URLSearchParams(location.search); p.set('room', code);
    return location.origin + location.pathname + '?' + p.toString();
  }

  function receive(v) {
    v._at = Date.now();
    if (v.round && v.round.n !== ui.round) { ui.round = v.round.n; ui.reveal = false; ui.struck = {}; ui.idea = null; ui.modal = null; ui.guess = null; }
    if (V && V.phase !== v.phase && v.phase === 'result') ui.modal = null;
    V = v;
    if (v.phase === 'playing') keepAwake();
    render();
  }

  let wake = null;
  async function keepAwake() {
    try { if ('wakeLock' in navigator && !wake) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => wake = null); } } catch (e) {}
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && V && V.phase !== 'lobby') keepAwake(); });

  // ---------------------------------------------------------------- rendering
  let toastTimer;
  function toast(text) {
    let el = document.querySelector('.toast');
    if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
    el.textContent = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), 3200);
  }

  const name = id => { const p = V && V.players.find(x => x.id === id); return p ? p.name : '?'; };
  const fmt = ms => { const s = Math.ceil(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const leftNow = () => !V || !V.round ? 0 : V.round.paused ? V.round.timeLeft : Math.max(0, V.round.timeLeft - (Date.now() - V._at));

  function topbar(right) {
    return `<div class="topbar"><a href="../index.html${keepParams()}">← หน้าแรก</a>${right || ''}<a href="#" data-act="rules">📖 กติกา</a></div>`;
  }

  function connBanner() {
    if (status === 'lost') return `<div class="banner">📡 หลุดการเชื่อมต่อ กำลังต่อใหม่… (ถ้าหัวห้องปิดเว็บไป ให้หัวห้องเปิดเว็บกลับมา)</div>`;
    if (status === 'reclaim') return `<div class="banner">🔄 กำลังเปิดห้อง ${esc(code)} กลับมา…</div>`;
    return '';
  }

  let lastHtml = '';
  function setApp(html) { if (html !== lastHtml) { $app.innerHTML = html; lastHtml = html; } }

  function render() {
    if (!V && status === 'idle') { lastHtml = ''; return renderEntry(); }
    if (!V) {
      setApp(topbar() + `<div class="panel center stack"><div style="font-size:3rem">📡</div><h2>กำลังเชื่อมต่อห้อง ${esc(code || '')}…</h2>
        <p class="muted small">ถ้านานเกินไป ลองเช็กว่าหัวห้องยังเปิดหน้าเกมอยู่</p>
        <button class="ghost" data-act="leave">ยกเลิก</button></div>` + connBanner());
      return renderModal();
    }
    if (V.phase === 'lobby') renderLobby();
    else if (V.phase === 'result') renderResult();
    else renderGame();
    renderModal();
  }

  function renderEntry() {
    const room = (qs.get('room') || '').toUpperCase();
    $app.innerHTML = topbar() + `
      <div class="hub-head"><div class="logo">🕵️</div><h1>ใครคือสายลับ?</h1>
      <p class="muted">ทุกคนรู้ว่าอยู่ที่ไหน… ยกเว้นสายลับ 1 คน</p></div>
      <div class="panel stack">
        <label class="muted small" for="name">ชื่อของคุณ</label>
        <input type="text" id="name" maxlength="16" placeholder="เช่น ต้น, มิว, แบงค์" value="${esc(me.name)}" autocomplete="nickname">
        ${room ? `
          <button data-act="join">🚪 เข้าห้อง ${esc(room)}</button>
          <button class="ghost" data-act="forget-room">สร้างห้องของตัวเองแทน</button>` : `
          <button data-act="create">✨ สร้างห้องใหม่</button>
          <div class="center muted small">หรือเข้าห้องเพื่อน</div>
          <div class="row"><input type="text" id="code" class="code" maxlength="4" placeholder="รหัส" autocomplete="off"></div>
          <button class="secondary" data-act="join">🚪 เข้าร่วมห้อง</button>`}
      </div>
      <p class="muted small center">ทุกคนเล่นผ่านมือถือของตัวเอง · ต้องมีอย่างน้อย ${MIN_PLAYERS} คน</p>`;
    const n = document.getElementById('name');
    if (!me.name) n.focus();
  }

  function playerList(opts) {
    const scores = opts && opts.sort ? [...V.players].sort((a, b) => b.score - a.score) : V.players;
    const canKick = V.me === V.hostId && (V.phase === 'lobby' || V.phase === 'result');
    return `<ul class="players">${scores.map(p => `
      <li class="${p.connected ? '' : 'off'}">
        <span class="dot ${p.connected ? '' : 'off'}"></span>
        <span class="name">${esc(p.name)} ${p.id === V.hostId ? '<span class="badge">หัวห้อง</span>' : ''} ${p.id === V.me ? '<span class="badge me">คุณ</span>' : ''}
          ${opts && opts.mark && opts.mark[p.id] ? opts.mark[p.id] : ''}</span>
        <span class="score">${p.score}</span>
        ${canKick && p.id !== V.hostId ? `<button class="small secondary" data-act="kick" data-id="${p.id}">✕</button>` : ''}
      </li>`).join('')}</ul>`;
  }

  function renderLobby() {
    const host = V.me === V.hostId;
    const online = V.players.filter(p => p.connected).length;
    setApp(topbar() + connBanner() + `
      <div class="panel center">
        <div class="muted small">รหัสห้อง</div>
        <div class="roomcode">${esc(V.code)}</div>
        <div class="qr" id="qr"></div>
        <div class="muted small">ให้เพื่อนสแกน QR หรือกดลิงก์เชิญ</div>
        <div class="row" style="margin-top:10px"><button class="secondary" data-act="share">🔗 แชร์ลิงก์เชิญ</button></div>
      </div>
      <div class="panel">
        <h3>ผู้เล่น (${online} คน)</h3>
        ${playerList()}
      </div>
      <div class="panel stack">
        <div><b>⏱️ เวลาต่อรอบ</b> <span class="muted small">(แนะนำ 5–7 นาที)</span></div>
        <div class="seg">${[5, 6, 7].map(m => `<button class="${V.minutes === m ? 'on' : ''}" data-act="minutes" data-v="${m}" ${host ? '' : 'disabled'}>${m} นาที</button>`).join('')}</div>
        ${host ? `
          <button class="good" data-act="start" ${online < MIN_PLAYERS ? 'disabled' : ''}>🚀 เริ่มเกม</button>
          ${online < MIN_PLAYERS ? `<div class="center muted small">ต้องมีอย่างน้อย ${MIN_PLAYERS} คน (ตอนนี้ ${online} คน)</div>` : ''}
          <div class="center muted small">⚠️ หัวห้องอย่าปิดหน้านี้ระหว่างเล่นนะ ห้องอยู่บนมือถือเครื่องนี้</div>`
        : `<div class="center muted">⏳ รอหัวห้องกดเริ่มเกม…</div>`}
      </div>
      <button class="ghost" data-act="leave">ออกจากห้อง</button>`);
    drawQR();
  }

  function drawQR() {
    const el = document.getElementById('qr');
    if (!el || typeof qrcode === 'undefined') return;
    try {
      const q = qrcode(0, 'M'); q.addData(inviteLink()); q.make();
      el.innerHTML = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    } catch (e) {}
  }

  function secretCard() {
    const r = V.round;
    if (!ui.reveal) return `<div class="secret hidden" data-act="reveal"><div><div class="big">🃏</div><div class="title">แตะเพื่อดูการ์ด</div><div class="muted small">อย่าให้คนข้าง ๆ เห็นนะ!</div></div></div>`;
    if (r.spy) return `<div class="secret spy" data-act="reveal"><div><div class="big">🕵️</div><div class="title">คุณคือสายลับ!</div>
      <div class="small">คุณไม่รู้ว่าที่นี่คือที่ไหน ตอบให้เนียน ฟังให้ดี แล้วทายสถานที่ให้ถูก</div><div class="muted small">(แตะเพื่อซ่อน)</div></div></div>`;
    return `<div class="secret agent" data-act="reveal"><div><div class="muted small">สถานที่ของเรา</div><div class="big">${LOCS[r.loc][0]}</div><div class="title">${esc(LOCS[r.loc][1])}</div>
      <div class="small">คุณไม่ใช่สายลับ หาให้เจอว่าใครไม่รู้สถานที่นี้</div><div class="muted small">(แตะเพื่อซ่อน)</div></div></div>`;
  }

  function turnPanel() {
    const r = V.round;
    const others = r.players.filter(id => id !== V.me);
    if (r.asker === V.me && !r.target) {
      if (!ui.idea) ui.idea = pick(QUESTIONS);
      return `<div class="panel"><div class="turn">🎤 <b>ตาคุณถาม!</b> เลือกคนที่จะถาม</div>
        <div class="choices">${others.map(id => `<button data-act="ask" data-id="${id}">${esc(name(id))}</button>`).join('')}</div>
        <div class="idea">💡 ไอเดียคำถาม: ${esc(ui.idea)} <button class="small ghost" data-act="idea">สุ่มใหม่</button></div>
        <div class="muted small" style="margin-top:6px">อย่าถามตรงเกินไป ไม่งั้นสายลับเดาได้ง่าย!</div></div>`;
    }
    if (r.target === V.me) {
      return `<div class="panel stack"><div class="turn">🙋 <b>${esc(name(r.asker))}</b> ถามคุณ!</div>
        <div class="center muted small">ตอบโดยห้ามบอกชื่อสถานที่ตรง ๆ</div>
        <button data-act="answered">✅ ตอบเสร็จแล้ว ถึงตาฉันถามต่อ</button></div>`;
    }
    if (r.target) {
      return `<div class="panel"><div class="turn"><b>${esc(name(r.asker))}</b> กำลังถาม <b>${esc(name(r.target))}</b></div>
        ${r.asker === V.me ? '<div class="center muted small">ถามเสร็จแล้วรอให้อีกฝ่ายตอบ</div>' : ''}
        ${V.me === V.hostId && r.target !== V.me ? '<div style="margin-top:8px"><button class="small ghost" data-act="answered">ข้ามไป (ถ้าอีกฝ่ายลืมกด)</button></div>' : ''}</div>`;
    }
    return `<div class="panel"><div class="turn">⏳ <b>${esc(name(r.asker))}</b> กำลังเลือกคนที่จะถาม…</div></div>`;
  }

  function votePanel() {
    const r = V.round, vt = r.vote;
    const allowed = (vt.candidates || r.players).filter(id => id !== V.me);
    const voters = r.players.filter(id => (V.players.find(p => p.id === id) || {}).connected);
    const canCancel = !vt.final && !vt.tie && (V.me === vt.caller || V.me === V.hostId);
    return `<div class="panel stack">
      <h2 class="center">${vt.final ? '⏰ หมดเวลา! โหวตรอบสุดท้าย' : `🗳️ ${esc(name(vt.caller))} เรียกโหวต`}</h2>
      ${vt.tie ? '<div class="banner">⚖️ คะแนนเสมอ! โหวตใหม่เฉพาะคนที่เสมอ (ถ้าเสมออีก สายลับชนะ)</div>' : ''}
      ${!vt.final ? '<div class="center muted small">เวลาหยุดชั่วคราวระหว่างโหวต</div>' : ''}
      ${r.playing ? `<div class="center">ใครคือสายลับ? ${vt.myVote ? '(เปลี่ยนใจได้จนกว่าจะนับคะแนน)' : ''}</div>
        <div class="choices">${allowed.map(id => `<button class="${vt.myVote === id ? 'on' : ''}" data-act="vote" data-id="${id}">${esc(name(id))}</button>`).join('')}</div>`
        : '<div class="center muted">รอบนี้คุณเป็นผู้ชม</div>'}
      <div class="center muted small">โหวตแล้ว ${vt.voted.length}/${voters.length} คน · ${voters.map(id => (vt.voted.includes(id) ? '✅' : '⌛') + esc(name(id))).join(' ')}</div>
      <div class="center small" style="color:var(--accent2)">ถ้าโหวตผิดคน สายลับชนะทันที!</div>
      ${V.me === V.hostId ? '<button class="secondary" data-act="tally">นับคะแนนเลย</button>' : ''}
      ${canCancel ? '<button class="ghost" data-act="cancelVote">ยกเลิกโหวต เล่นต่อ</button>' : ''}
    </div>`;
  }

  function locGrid() {
    const r = V.round;
    return `<div class="panel"><h3>📍 สถานที่ที่เป็นไปได้ <span class="muted small">(แตะเพื่อขีดฆ่า)</span></h3>
      <div class="locs">${LOCS.map((l, i) => `<button class="loc ${ui.struck[i] ? 'struck' : ''}" data-act="strike" data-i="${i}"><span class="e">${l[0]}</span>${esc(l[1])}</button>`).join('')}</div></div>`;
  }

  function renderGame() {
    const r = V.round;
    const low = !r.paused && leftNow() < 60000;
    setApp(topbar(`<span class="muted small">รอบ ${r.n} · ห้อง ${esc(V.code)}</span>`) + connBanner() + `
      <div class="timer ${r.paused ? 'paused' : low ? 'low' : ''}" id="timer">${fmt(leftNow())}</div>
      ${r.playing ? secretCard() : '<div class="panel center">👀 รอบนี้คุณเป็นผู้ชม รอรอบถัดไปนะ</div>'}
      ${V.phase === 'voting' ? votePanel() : turnPanel()}
      ${r.playing ? `<div class="stack">
        ${V.phase === 'playing' ? '<button class="secondary" data-act="callVote">🗳️ เรียกโหวตจับสายลับ</button>' : ''}
        ${r.spy ? '<button class="danger" data-act="openGuess">🎯 หยุดเกม! สายลับขอทายสถานที่</button>' : ''}
      </div>` : ''}
      ${locGrid()}
      <div class="panel"><h3>ผู้เล่นรอบนี้ <span class="muted small">(คะแนนรวม)</span></h3>${playerList()}</div>
      <div class="panel"><h3>บันทึก</h3><div class="log">${r.log.slice().reverse().map(l => `<div>${esc(l)}</div>`).join('')}</div></div>
      <button class="ghost" data-act="leave">ออกจากห้อง</button>`);
  }

  function renderResult() {
    const r = V.round, res = r.result;
    const spyName = esc(name(r.spyId));
    const reasons = {
      caught: `จับได้! <b>${esc(name(res.accused))}</b> คือสายลับจริง ๆ`,
      wrong: `โหวตผิดคน! <b>${esc(name(res.accused))}</b> ไม่ใช่สายลับ`,
      tie: 'โหวตเสมอสองรอบ จับสายลับไม่ได้',
      guessRight: `สายลับทายสถานที่ถูกต้อง!`,
      guessWrong: `สายลับทายผิด! ทายว่า ${res.guess != null ? esc(locName(res.guess)) : ''}`,
    };
    const counts = r.vote && r.vote.counts;
    const mark = {};
    mark[r.spyId] = '🕵️';
    const iWon = r.playing && ((res.winner === 'spy') === (r.spyId === V.me));
    const host = V.me === V.hostId;
    setApp(topbar(`<span class="muted small">รอบ ${r.n} · ห้อง ${esc(V.code)}</span>`) + connBanner() + `
      <div class="result-hero ${res.winner}">
        <div class="big">${res.winner === 'spy' ? '🕵️' : '🎉'}</div>
        <h1>${res.winner === 'spy' ? 'สายลับชนะ!' : 'ฝ่ายคนปกติชนะ!'}</h1>
        <div>${reasons[res.reason] || ''}</div>
        ${r.playing ? `<div style="margin-top:8px">${iWon ? '🏆 คุณชนะรอบนี้!' : '😢 คุณแพ้รอบนี้'}</div>` : ''}
      </div>
      <div class="panel center">
        <div>สายลับคือ <b style="color:var(--accent2)">${spyName}</b></div>
        <div>สถานที่คือ <b style="color:var(--good)">${esc(locName(r.loc))}</b></div>
        ${counts ? `<div class="muted small" style="margin-top:6px">ผลโหวต: ${Object.entries(counts).map(([id, n]) => `${esc(name(id))} ${n}`).join(' · ')}</div>` : ''}
      </div>
      <div class="panel"><h3>🏆 คะแนนรวม</h3>${playerList({ sort: true, mark })}
        <div class="muted small" style="margin-top:6px">สายลับชนะ +2 ให้สายลับ · คนปกติชนะ +1 ทุกคนที่ไม่ใช่สายลับ</div></div>
      ${host ? `<div class="panel stack">
          <div class="seg">${[5, 6, 7].map(m => `<button class="${V.minutes === m ? 'on' : ''}" data-act="minutes" data-v="${m}">${m} นาที</button>`).join('')}</div>
          <button class="good" data-act="start">🔁 เล่นรอบใหม่</button>
          <button class="secondary" data-act="lobby">กลับห้องรอ (เชิญคนเพิ่ม)</button></div>`
        : '<div class="center muted">⏳ รอหัวห้องเริ่มรอบใหม่…</div>'}
      <div class="panel"><h3>บันทึกรอบนี้</h3><div class="log">${r.log.slice().reverse().map(l => `<div>${esc(l)}</div>`).join('')}</div></div>
      <button class="ghost" data-act="leave">ออกจากห้อง</button>`);
  }

  function renderModal() {
    if (ui.modal === 'rules') {
      $modal.innerHTML = `<div class="modal-bg" data-act="close"><div class="modal rules" data-stop>
        <h2>📖 วิธีเล่น ใครคือสายลับ? 🕵️</h2>
        <h3>1. เริ่มเกม</h3><ul>
          <li>เล่นได้ตั้งแต่ 4 คนขึ้นไป</li>
          <li>แจกการ์ดให้ทุกคนคนละ 1 ใบ (เปิดดูบนมือถือของตัวเอง)</li>
          <li>ทุกคนจะได้การ์ดสถานที่เดียวกัน ยกเว้น 1 คนที่ได้การ์ดสายลับ</li>
          <li>คนที่เป็นสายลับจะไม่รู้ว่าสถานที่คืออะไร</li></ul>
        <h3>2. วิธีเล่น</h3><ul>
          <li>ระบบสุ่มคนเริ่มถามคำถามผู้เล่นคนอื่น</li>
          <li>คนที่ถูกถามต้องตอบคำถาม โดยห้ามบอกชื่อสถานที่ตรง ๆ</li>
          <li>ตอบเสร็จแล้วกด "ตอบเสร็จแล้ว" แล้วเลือกถามคนอื่นต่อได้</li>
          <li>ทุกคนต้องพยายามจับผิดว่าใครคือสายลับ</li>
          <li>สายลับต้องเนียนตอบคำถามและพยายามเดาสถานที่ให้ถูก</li></ul>
        <h3>3. เงื่อนไขการชนะ</h3><ul>
          <li>ฝ่ายคนปกติ: ต้องจับสายลับให้ถูกตัว</li>
          <li>ฝ่ายสายลับ: ต้องเอาตัวรอดจนหมดเวลา หรือทายสถานที่ได้ถูกต้อง</li></ul>
        <h3>4. กติกาพิเศษ</h3><ul>
          <li>สายลับสามารถหยุดเกมเพื่อทายสถานที่ได้ทุกเมื่อ (ทายถูกชนะ ทายผิดแพ้)</li>
          <li>ใครก็กด "เรียกโหวต" ได้ทุกเมื่อ และเมื่อหมดเวลาจะมีโหวตรอบสุดท้าย</li>
          <li>ถ้าผู้เล่นโหวตผิดคน สายลับชนะ (คะแนนเสมอโหวตใหม่ได้ 1 ครั้ง)</li>
          <li>แนะนำให้ตั้งเวลาเกมละ 5–7 นาที</li></ul>
        <h3>5. ตัวอย่างคำถาม</h3><ul>${QUESTIONS.slice(0, 5).map(q => `<li>${esc(q)}</li>`).join('')}</ul>
        <p><b>ข้อควรระวัง:</b> ห้ามถามคำถามตรงเกินไป เพราะจะทำให้สายลับเดาสถานที่ได้ง่าย!</p>
        <button data-act="close">เข้าใจแล้ว</button></div></div>`;
    } else if (ui.modal === 'guess' && V && V.round && V.round.spy) {
      $modal.innerHTML = `<div class="modal-bg" data-act="close"><div class="modal" data-stop>
        <h2>🎯 ทายสถานที่</h2>
        <p class="muted small">ทายได้ครั้งเดียว! ทายถูกสายลับชนะ ทายผิดสายลับแพ้ (ทุกคนจะรู้ทันทีว่าคุณคือสายลับ)</p>
        <div class="locs">${LOCS.map((l, i) => `<button class="loc ${ui.guess === i ? 'pick' : ''} ${ui.struck[i] ? 'struck' : ''}" data-act="pickGuess" data-i="${i}"><span class="e">${l[0]}</span>${esc(l[1])}</button>`).join('')}</div>
        <div class="stack" style="margin-top:14px">
          <button class="danger" data-act="confirmGuess" ${ui.guess == null ? 'disabled' : ''}>${ui.guess == null ? 'เลือกสถานที่ก่อน' : 'ยืนยัน: ' + esc(locName(ui.guess))}</button>
          <button class="ghost" data-act="close">ยังก่อน</button></div></div></div>`;
    } else $modal.innerHTML = '';
  }

  // ---------------------------------------------------------------- events
  function readName() {
    const el = document.getElementById('name');
    const n = cleanName(el && el.value);
    if (!n) { toast('ใส่ชื่อก่อนนะ'); el && el.focus(); return false; }
    me.name = n; saveMe(); return true;
  }

  document.addEventListener('click', e => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    if (t.dataset.act === 'close' && e.target.closest('[data-stop]') && t.classList.contains('modal-bg')) return;
    const d = t.dataset;
    switch (d.act) {
      case 'rules': e.preventDefault(); ui.modal = 'rules'; renderModal(); break;
      case 'close': ui.modal = null; renderModal(); break;
      case 'create': if (readName()) startHost(null); break;
      case 'join': {
        if (!readName()) break;
        const c = ((document.getElementById('code') || {}).value || qs.get('room') || '').toUpperCase().trim();
        if (c.length !== 4) { toast('ใส่รหัสห้อง 4 ตัว'); break; }
        startJoin(c, false); break;
      }
      case 'forget-room': qs.delete('room'); history.replaceState(null, '', location.pathname + keepParams()); render(); break;
      case 'leave': leave(false); break;
      case 'share': {
        const link = inviteLink();
        if (navigator.share) navigator.share({ title: 'มาเล่น ใครคือสายลับ? กัน', text: `รหัสห้อง ${code}`, url: link }).catch(() => {});
        else navigator.clipboard.writeText(link).then(() => toast('คัดลอกลิงก์แล้ว'), () => prompt('คัดลอกลิงก์นี้', link));
        break;
      }
      case 'minutes': act({ t: 'minutes', v: +d.v }); break;
      case 'start': act({ t: 'start' }); break;
      case 'lobby': act({ t: 'lobby' }); break;
      case 'kick': if (confirm(`เชิญ ${name(d.id)} ออกจากห้อง?`)) act({ t: 'kick', target: d.id }); break;
      case 'reveal': ui.reveal = !ui.reveal; render(); break;
      case 'idea': ui.idea = pick(QUESTIONS.filter(q => q !== ui.idea)); render(); break;
      case 'ask': act({ t: 'ask', target: d.id }); ui.idea = null; break;
      case 'answered': act({ t: 'answered' }); break;
      case 'callVote': if (confirm('เรียกโหวตจับสายลับตอนนี้? ถ้าโหวตผิดคน สายลับชนะทันที')) act({ t: 'callVote' }); break;
      case 'cancelVote': act({ t: 'cancelVote' }); break;
      case 'vote': act({ t: 'vote', target: d.id }); break;
      case 'tally': if (confirm('นับคะแนนจากคนที่โหวตแล้วตอนนี้เลย?')) act({ t: 'tally' }); break;
      case 'strike': ui.struck[d.i] = !ui.struck[d.i]; t.classList.toggle('struck'); break;
      case 'openGuess': ui.modal = 'guess'; ui.guess = null; renderModal(); break;
      case 'pickGuess': ui.guess = +d.i; renderModal(); break;
      case 'confirmGuess': if (ui.guess != null) { act({ t: 'guess', loc: ui.guess }); ui.modal = null; renderModal(); } break;
    }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.id === 'code') document.querySelector('[data-act="join"]').click();
  });
  window.addEventListener('beforeunload', e => {
    if (isHost && S && S.players.some(p => p.connected && p.id !== me.id)) { e.preventDefault(); e.returnValue = ''; }
  });

  // timer tick (cheap: only touches the timer text)
  setInterval(() => {
    const el = document.getElementById('timer');
    if (!el || !V || !V.round) return;
    el.textContent = fmt(leftNow());
    el.className = 'timer ' + (V.round.paused ? 'paused' : leftNow() < 60000 ? 'low' : '');
  }, 250);

  // ---------------------------------------------------------------- boot
  const sess = JSON.parse(localStorage.getItem('spy.session') || 'null');
  const fresh = sess && Date.now() - sess.t < 4 * 3600 * 1000;
  const linkRoom = (qs.get('room') || '').toUpperCase();
  if (fresh && sess.host && (!linkRoom || linkRoom === sess.code)) {
    const saved = JSON.parse(localStorage.getItem('spy.host.' + sess.code) || 'null');
    if (saved) startHost(saved); else render();
  } else if (fresh && !sess.host && me.name && (!linkRoom || linkRoom === sess.code)) {
    startJoin(sess.code, true);
  } else render();

  window.__spy = { get V() { return V; }, get S() { return S; }, me }; // handy for debugging
})();
