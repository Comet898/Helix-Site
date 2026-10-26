/* Transport adapters for Scramjet v2. Built-in engine dependencies are not used here. */
(function (root) {
  "use strict";
  const errText = e => String((e && (e.message || e.reason)) || e || "");
  const SAFE = /^(GET|HEAD|OPTIONS)$/i;
  const MUX = /MuxTaskEnded|Multiplexor|mux task|Wisp.{0,30}(closed|ended|lost)/i;
  const BODY_LIMIT = 64 * 1024 * 1024;
  const abortError = () => { const e = new Error("Aborted"); e.name = "AbortError"; return e; };
  const checkAbort = signal => { if (signal && signal.aborted) throw abortError(); };

  function toPairs(h) {
    const out = [];
    const push = (k, v) => {
      if (v == null) return;
      if (Array.isArray(v)) { v.forEach(x => push(k, x)); return; }
      k = String(k); v = String(v);
      if (k.toLowerCase() === "set-cookie") {
        for (const c of v.split(/,(?=\s*[^;,=\s]+=)/)) if (c.trim()) out.push([k, c.trim()]);
      } else out.push([k, v]);
    };
    if (!h) return out;
    if (Array.isArray(h)) { for (const p of h) if (p && p.length >= 2) push(p[0], p[1]); return out; }
    if (typeof h.entries === "function" && typeof h.get === "function") {
      for (const [k,v] of h.entries()) if (k.toLowerCase() !== "set-cookie" || typeof h.getSetCookie !== "function") push(k,v);
      if (typeof h.getSetCookie === "function") for (const v of h.getSetCookie()) push("set-cookie",v);
      return out;
    }
    for (const k of Object.keys(h)) push(k,h[k]);
    return out;
  }

  function toObj(h) {
    const o = Object.create(null), seen = Object.create(null);
    for (const [k,v] of toPairs(h)) {
      const l = k.toLowerCase();
      if (seen[l] === undefined) { seen[l] = k; o[k] = v; }
      else o[seen[l]] += (l === "cookie" ? "; " : ", ") + v;
    }
    return o;
  }

  async function normBody(body, signal) {
    checkAbort(signal);
    if (body == null) return body;
    if (typeof body.getReader === "function") {
      const reader = body.getReader(), chunks = [];
      let size = 0, completed = false;
      const cancel = () => { Promise.resolve(reader.cancel("Aborted")).catch(() => {}); };
      if (signal) signal.addEventListener("abort",cancel,{once:true});
      try {
        for (;;) {
          checkAbort(signal);
          const {done,value} = await reader.read();
          checkAbort(signal);
          if (done) { completed = true; break; }
          const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
          size += bytes.byteLength;
          if (size > BODY_LIMIT) throw new RangeError("Streamed request body exceeds the 64 MiB replay-buffer limit");
          chunks.push(bytes);
        }
        const result = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { result.set(chunk,offset); offset += chunk.byteLength; }
        return result.buffer;
      } finally {
        if (signal) signal.removeEventListener("abort",cancel);
        if (!completed) try { await reader.cancel(); } catch (_) {}
        reader.releaseLock();
      }
    }
    if (typeof Blob !== "undefined" && body instanceof Blob) {
      if (body.size > BODY_LIMIT) throw new RangeError("Blob request body exceeds the 64 MiB replay-buffer limit");
      const result = await body.arrayBuffer(); checkAbort(signal); return result;
    }
    return body;
  }

  function retryable(method, err) {
    return !(err && err.name === "AbortError") && SAFE.test(method || "GET");
  }

  function deadline(run, ms, signal, message) {
    checkAbort(signal);
    const ctl = new AbortController();
    let timer, listener;
    const stop = new Promise((_,reject) => {
      listener = () => { reject(abortError()); ctl.abort(); };
      if (signal) signal.addEventListener("abort",listener,{once:true});
      timer = setTimeout(() => {
        const e = new Error(message); e.name = "TimeoutError";
        reject(e); ctl.abort();
      },ms);
    });
    const work = Promise.resolve().then(() => { checkAbort(ctl.signal); return run(ctl.signal); });
    return Promise.race([work,stop]).finally(() => {
      clearTimeout(timer); if (signal) signal.removeEventListener("abort",listener);
    });
  }

  /* Always return the synchronous [send, close] interface, even during async setup. */
  function socketBridge(start, onopen, onmessage, onclose, onerror) {
    let ended = false, pair = null, closeArgs = null;
    const callbacks = {
      open: (...a) => { if (!ended && onopen) onopen(...a); },
      message: (...a) => { if (!ended && onmessage) onmessage(...a); },
      close: (code,reason) => { if (ended) return; ended = true; if (onclose) onclose(code,reason); },
      error: e => { if (!ended && onerror) onerror(errText(e)); }
    };
    const pending = Promise.resolve().then(() => start(callbacks)).then(result => {
      if (!Array.isArray(result) || typeof result[0] !== "function" || typeof result[1] !== "function") throw new TypeError("Transport connect() did not return [send, close]");
      pair = result;
      if (closeArgs) pair[1](...closeArgs);
      return pair;
    });
    pending.catch(e => {
      if (!ended) { try { callbacks.error(e); } finally { callbacks.close(1006,"Transport connection setup failed"); } }
    });
    return [
      async data => { if (ended || closeArgs) throw new Error("WebSocket is closed"); const p = await pending; if (ended || closeArgs) throw new Error("WebSocket is closed"); return p[0](data); },
      (code,reason) => { if (ended || closeArgs) return; closeArgs = [code == null ? 1000 : code, reason || ""]; if (pair) return pair[1](...closeArgs); }
    ];
  }

  class AdapterTransport {
    constructor(inner,label,factory) {
      this.inner=inner; this.label=label||"transport"; this.factory=factory||null;
      this.ready=false; this.dead=false; this.sockets=new Set(); this.initializing=null; this.reviving=null;
      AdapterTransport.all.add(this);
    }
    async init() {
      if (this.ready && !this.dead) return;
      if (this.dead) return this.revive();
      if (!this.initializing) this.initializing=Promise.resolve().then(async()=>{if(!this.inner.ready)await this.inner.init();this.ready=true;}).finally(()=>{this.initializing=null;});
      return this.initializing;
    }
    async meta() {}
    markDead() {
      this.dead=true; this.ready=false;
      const list=[...this.sockets]; this.sockets.clear();
      for(const close of list)try{close(1006,"Wisp connection lost");}catch(_){}
    }
    async revive() {
      if (!this.factory) throw new Error(this.label+" connection is unavailable and has no rebuild factory");
      if (!this.reviving) this.reviving=Promise.resolve().then(async()=>{
        const next=await this.factory(); if(!next.ready)await next.init();
        this.inner=next;this.dead=false;this.ready=true;
      }).finally(()=>{this.reviving=null;});
      return this.reviving;
    }
    async request(remote,method,body,headers,signal) {
      body=await normBody(body,signal); const h=toObj(headers);
      if(this.dead)await this.revive();else await this.init();
      for(let attempt=0;;attempt++){
        checkAbort(signal);
        try{
          const r=await this.inner.request(remote,method,body,h,signal);
          return {body:r.body,headers:toPairs(r.headers),status:r.status,statusText:r.statusText};
        }catch(e){
          if(signal&&signal.aborted)throw abortError();
          if(!MUX.test(errText(e)))throw e;
          this.markDead();
          if(!this.factory||attempt>0||!retryable(method,e))throw e;
          await this.revive();
        }
      }
    }
    connect(url,protocols,requestHeaders,onopen,onmessage,onclose,onerror){
      const hdr=toObj(requestHeaders);
      return socketBridge(async cb=>{
        if(this.dead)await this.revive();else await this.init();
        let finished=false, innerPair=null;
        const finish=(code,reason)=>{
          if(finished)return;finished=true;this.sockets.delete(lost);cb.close(code,reason);
        };
        const lost=(code,reason)=>{
          if(finished)return;
          try{if(innerPair)innerPair[1](1000,"Transport reset");}catch(_){}
          finish(code,reason);
        };
        this.sockets.add(lost);
        try{
          innerPair=await this.inner.connect(url,protocols,hdr,
            (protocol,extensions)=>cb.open(protocol||"",extensions||""),cb.message,finish,
            e=>{cb.error(e);if(MUX.test(errText(e)))this.markDead();});
          if(finished&&innerPair)try{innerPair[1](1000,"Transport reset");}catch(_){}
          return innerPair;
        }catch(e){this.sockets.delete(lost);if(MUX.test(errText(e)))this.markDead();throw e;}
      },onopen,onmessage,onclose,onerror);
    }
    dispose(){this.markDead();AdapterTransport.all.delete(this);}
  }
  AdapterTransport.all=new Set();
  const markAllDead=()=>{for(const t of AdapterTransport.all)t.markDead();};

  class FallbackTransport {
    constructor(primary,secondaryFactory,log){
      this.primary=primary;this.secondaryFactory=secondaryFactory;this.secondary=null;
      this.secondaryLoading=null;this.log=log||function(){};this.ready=false;this.primaryDown=false;
      this.prefs=new Map();this.label="auto";
    }
    async init(){
      try{await this.primary.init();}catch(e){this.log("warn","transport",this.primary.label+" could not start ("+errText(e).slice(0,160)+"), using the other transport");await this.getSecondary();this.primaryDown=true;}
      this.ready=true;
    }
    async meta(){}
    async getSecondary(){
      if(this.secondary&&this.secondary.ready)return this.secondary;
      if(!this.secondaryLoading)this.secondaryLoading=Promise.resolve().then(async()=>{
        const t=this.secondary||await this.secondaryFactory();if(!t.ready)await t.init();this.secondary=t;return t;
      }).finally(()=>{this.secondaryLoading=null;});
      return this.secondaryLoading;
    }
    prefers(host){
      if(this.primaryDown)return "secondary";
      const p=this.prefs.get(host);if(!p)return "primary";
      if(p.until<Date.now()){this.prefs.delete(host);return "primary";}return p.which;
    }
    async get(which){return which==="primary"?(this.primaryDown?null:this.primary):this.getSecondary();}
    async request(remote,method,body,headers,signal){
      body=await normBody(body,signal);const host=remote.hostname;
      const first=this.prefers(host),order=first==="primary"?["primary","secondary"]:["secondary","primary"];
      let lastErr;
      for(let i=0;i<order.length;i++){
        checkAbort(signal);let t;
        try{t=await this.get(order[i]);}catch(e){lastErr=e;continue;}if(!t)continue;
        try{
          const r=await t.request(remote,method,body,headers,signal);
          if(i>0){this.prefs.set(host,{which:order[i],until:Date.now()+600000});this.log("info","transport",host+" loaded through "+t.label+" after "+order[0]+" failed");}return r;
        }catch(e){
          if(signal&&signal.aborted)throw abortError();lastErr=e;
          const more=i<order.length-1&&retryable(method,e);
          this.log("warn","transport",t.label+" failed for "+host+": "+errText(e).slice(0,220)+(more?" (retrying with the other transport)":""));
          if(!more)break;
        }
      }
      throw lastErr||new Error("No transport available");
    }
    connect(url,protocols,headers,onopen,onmessage,onclose,onerror){
      return socketBridge(async cb=>{
        const which=this.prefers(url.hostname);
        const t=await this.get(which);if(!t)throw new Error("No transport available");
        return t.connect(url,protocols,headers,cb.open,cb.message,cb.close,cb.error);
      },onopen,onmessage,onclose,onerror);
    }
  }

  class WispPoolTransport {
    constructor(urls,factory,log){
      this.urls=[...new Set(urls)];this.factory=factory;this.log=log||function(){};
      this.ts=new Map();this.bad=new Map();this.prefs=new Map();this.ready=false;this.label="pool";
      this.startTimeout=15000;this.requestTimeout=25000;this.maxAttempts=3;this.morePending=null;
    }
    async get(i){
      if(i<0||i>=this.urls.length)throw new Error("Invalid Wisp pool index");
      let p=this.ts.get(i);
      if(!p){p=Promise.resolve().then(async()=>{const t=await this.factory(this.urls[i]);if(!t.ready)await t.init();return t;});this.ts.set(i,p);p.catch(()=>{if(this.ts.get(i)===p)this.ts.delete(i);});}
      return p;
    }
    async init(){
      let err;
      for(let i=0;i<this.urls.length;i++)try{await deadline(()=>this.get(i),this.startTimeout,null,"Wisp transport start timed out");this.cur=i;this.ready=true;return;}catch(e){err=e;}
      throw err||new Error("No transport available");
    }
    async meta(){}
    pinned(host){const p=this.prefs.get(host);if(p&&p.until>Date.now())return p.i;if(p)this.prefs.delete(host);return -1;}
    order(host){
      const now=Date.now(),pin=this.pinned(host),first=pin>=0?pin:(this.cur||0);
      const all=this.urls.map((_,i)=>i),rest=all.filter(i=>i!==first);
      const rank=a=>a.filter(i=>!(this.bad.get(i)>now)).concat(a.filter(i=>this.bad.get(i)>now));
      return pin>=0?[first,...rank(rest)]:rank(all.includes(first)?[first,...rest]:all);
    }
    async needMore(){
      if(!this.onNeedMore)return;
      if(!this.morePending)this.morePending=Promise.resolve().then(()=>this.onNeedMore()).finally(()=>{this.morePending=null;});
      return this.morePending;
    }
    async request(remote,method,body,headers,signal){
      body=await normBody(body,signal);const host=remote.hostname,path=remote.pathname||"";
      const order=this.order(host),safe=SAFE.test(method||"GET"),challenge=/^\/cdn-cgi\//.test(path);
      let lastErr,tries=0,askedMore=false;
      for(let k=0;k<order.length&&tries<this.maxAttempts;k++){
        checkAbort(signal);const i=order[k];const pinnedHere=this.pinned(host)===i;
        try{
          const t=await deadline(()=>this.get(i),this.startTimeout,signal,"Wisp transport start timed out");
          checkAbort(signal);tries++;
          const r=await deadline(s=>t.request(remote,method,body,headers,s),this.requestTimeout,signal,"Wisp request timed out; cancellation requested");
          this.prefs.set(host,{i,until:Date.now()+1800000});this.bad.delete(i);
          if(k>0)this.log("info","wisp",host+" loaded through "+this.urls[i]);return r;
        }catch(e){
          if(signal&&signal.aborted)throw abortError();lastErr=e;
          if(!retryable(method,e)||pinnedHere&&challenge)break;
          this.bad.set(i,Date.now()+120000);
          if(k===order.length-1&&this.onNeedMore&&!askedMore){askedMore=true;try{await deadline(()=>this.needMore(),this.startTimeout,signal,"Wisp pool discovery timed out");}catch(x){if(signal&&signal.aborted)throw abortError();}for(const j of this.order(host))if(!order.includes(j))order.push(j);}
          this.log("warn","wisp",this.urls[i]+" failed for "+host+": "+errText(e).slice(0,160)+(k<order.length-1?" (trying next server)":""));
          if(!safe)break;
        }
      }
      throw lastErr||new Error("No transport available");
    }
    connect(url,protocols,headers,onopen,onmessage,onclose,onerror){
      return socketBridge(async cb=>{
        let lastErr;
        for(const i of this.order(url.hostname).slice(0,this.maxAttempts)){
          try{
            const t=await deadline(()=>this.get(i),this.startTimeout,null,"Wisp transport start timed out");
            return await t.connect(url,protocols,headers,
              (...a)=>{this.prefs.set(url.hostname,{i,until:Date.now()+1800000});this.bad.delete(i);cb.open(...a);},
              cb.message,cb.close,cb.error);
          }catch(e){lastErr=e;this.log("warn","wisp",this.urls[i]+" websocket setup failed: "+errText(e).slice(0,160));}
        }
        throw lastErr||new Error("No transport available");
      },onopen,onmessage,onclose,onerror);
    }
  }
  const api={MUX,markAllDead,toPairs,toObj,normBody,retryable,AdapterTransport,FallbackTransport,WispPoolTransport};
  root.HZTransport=api;
  if(typeof module!=="undefined"&&module.exports)module.exports=api;
})(typeof self!=="undefined"?self:globalThis);
