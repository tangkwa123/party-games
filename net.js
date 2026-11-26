// Shared realtime room layer for every game in the hub.
// One phone (the host) owns the game state; the others connect to it over WebRTC
// using the free public PeerJS signalling server, so no account or backend is needed.
(function () {
  const PREFIX = 'th-partyhub-v1-';
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  function peerOptions() {
    const p = new URLSearchParams(location.search);
    const o = { debug: 1 };
    if (p.get('peerhost')) { // optional self-hosted signalling server (used for testing)
      o.host = p.get('peerhost');
      o.port = +(p.get('peerport') || 9000);
      o.path = p.get('peerpath') || '/';
      o.secure = p.get('peersecure') === '1';
    }
    return o;
  }

  function newCode() {
    let s = '';
    for (let i = 0; i < 4; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    return s;
  }

  function peerId(game, code) { return PREFIX + game + '-' + code.toUpperCase(); }

  // ---------- host ----------
  // h: { onOpen(), onData(connId, msg), onClose(connId), onError(type) }
  function host(game, code, h) {
    const conns = new Map(); // connId -> { conn, last }
    let peer, tries = 0, dead = false;

    function start() {
      peer = new Peer(peerId(game, code), peerOptions());
      peer.on('open', () => { tries = 0; h.onOpen && h.onOpen(); });
      peer.on('connection', conn => {
        conn.on('open', () => conns.set(conn.connectionId, { conn, last: Date.now() }));
        conn.on('data', msg => {
          const c = conns.get(conn.connectionId);
          if (c) c.last = Date.now();
          if (msg && msg.__ping) return;
          h.onData(conn.connectionId, msg);
        });
        conn.on('close', () => drop(conn.connectionId));
        conn.on('error', () => drop(conn.connectionId));
      });
      peer.on('disconnected', () => { if (!dead) setTimeout(() => { try { peer.reconnect(); } catch (e) {} }, 1500); });
      peer.on('error', e => {
        // after a page reload the old id can stay reserved for a little while: keep trying
        if (e.type === 'unavailable-id' && tries < 40) {
          tries++; try { peer.destroy(); } catch (x) {}
          setTimeout(start, 1500);
          h.onError && h.onError('waiting-id');
          return;
        }
        if (e.type === 'peer-unavailable') return;
        h.onError && h.onError(e.type);
      });
    }

    function drop(id) {
      if (!conns.has(id)) return;
      const c = conns.get(id); conns.delete(id);
      try { c.conn.close(); } catch (x) {}
      h.onClose(id);
    }

    // heartbeat: detect phones that went to sleep or lost signal
    const hb = setInterval(() => {
      const now = Date.now();
      for (const [id, c] of conns) {
        if (now - c.last > 16000) drop(id);
        else try { c.conn.send({ __ping: 1 }); } catch (x) {}
      }
    }, 4000);

    start();
    return {
      send(id, msg) { const c = conns.get(id); if (c && c.conn.open) try { c.conn.send(msg); } catch (x) {} },
      kick(id) { drop(id); },
      destroy() { dead = true; clearInterval(hb); try { peer.destroy(); } catch (x) {} },
    };
  }

  // ---------- player ----------
  // h: { onOpen(), onData(msg), onClose(), onError(type) }
  function join(game, code, h) {
    let peer, conn = null, last = 0, wasOpen = false, dead = false, connecting = false, timer = null;
    const target = peerId(game, code);

    function makePeer() {
      peer = new Peer(peerOptions());
      peer.on('open', connect);
      peer.on('disconnected', () => { if (!dead) setTimeout(() => { try { peer.reconnect(); } catch (e) {} }, 1500); });
      peer.on('error', e => {
        connecting = false;
        if (e.type === 'peer-unavailable') {
          h.onError && h.onError(wasOpen ? 'host-gone' : 'no-room');
          if (wasOpen) retry(3000);
          return;
        }
        h.onError && h.onError(e.type);
        retry(3000);
      });
    }

    function connect() {
      if (dead || connecting) return;
      if (!peer || peer.destroyed) return makePeer();
      if (peer.disconnected) { try { peer.reconnect(); } catch (e) {} return retry(2000); }
      connecting = true;
      const c = peer.connect(target, { reliable: true });
      const t = setTimeout(() => { if (!c.open) { connecting = false; try { c.close(); } catch (x) {} retry(1000); } }, 10000);
      c.on('open', () => {
        clearTimeout(t); connecting = false; conn = c; wasOpen = true; last = Date.now();
        h.onOpen && h.onOpen();
      });
      c.on('data', msg => {
        last = Date.now();
        if (msg && msg.__ping) { try { c.send({ __ping: 1 }); } catch (x) {} return; }
        h.onData(msg);
      });
      c.on('close', () => lost(c));
      c.on('error', () => lost(c));
    }

    function lost(c) {
      if (conn !== c) return;
      conn = null;
      h.onClose && h.onClose();
      retry(1500);
    }

    function retry(ms) {
      if (dead) return;
      clearTimeout(timer);
      timer = setTimeout(connect, ms);
    }

    const watchdog = setInterval(() => {
      if (conn && Date.now() - last > 16000) { const c = conn; try { c.close(); } catch (x) {} lost(c); }
    }, 4000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !conn && !dead) retry(100);
    });

    makePeer();
    return {
      send(msg) { if (conn && conn.open) { try { conn.send(msg); return true; } catch (x) {} } return false; },
      get connected() { return !!conn; },
      destroy() { dead = true; clearInterval(watchdog); clearTimeout(timer); try { peer.destroy(); } catch (x) {} },
    };
  }

  window.PartyNet = { host, join, newCode };
})();
