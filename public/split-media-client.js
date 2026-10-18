(function(root) {
  'use strict';
  /** Separate media lifetime; control and native session are never closed here. */
  class SplitMediaClient {
    constructor(options) { this.o=options; this.socket=null; this.epoch=0; this.timer=null; this.backoff=500; this.stopped=false; }
    cancelTimer() { if(this.timer!==null) { clearTimeout(this.timer);this.timer=null; } }
    stop() {
      this.stopped=true;this.cancelTimer();++this.epoch;
      const old=this.socket;this.socket=null;
      if(old) { old.onopen=old.onmessage=old.onclose=old.onerror=null;old.close(); }
    }
    accept(msg) {
      if(this.stopped || msg.role!=='browser' || msg.sessionId!==this.o.session() ||
        !/^[a-f0-9]{64}$/.test(msg.capability) || msg.expiresAt<=Date.now()) return false;
      const control=this.o.control();
      if(!control || control.readyState!==WebSocket.OPEN) return false;
      this.cancelTimer();const epoch=++this.epoch;
      const old=this.socket;this.socket=null;
      if(old) {old.onopen=old.onmessage=old.onerror=old.onclose=null;old.close();}
      this.o.generation(msg.generation);
      // Credentials only in the handshake, on the existing trusted origin.
      const endpoint=new URL(this.o.url);
      endpoint.pathname='/ws/media';endpoint.search='';endpoint.hash='';
      const socket=new WebSocket(endpoint.toString(),['karcast-v1','media_cap.'+msg.capability]);this.socket=socket;
      const current=()=>!this.stopped && this.epoch===epoch && this.socket===socket && this.o.control()===control;
      const retry=()=>{
        if(!current())return;
        ++this.epoch;this.socket=null;socket.onopen=socket.onmessage=socket.onclose=socket.onerror=null;socket.close();
        this.cancelTimer();this.o.event('media-retry');
        this.timer=setTimeout(()=>{
          this.timer=null;
          if(this.stopped || this.o.control()!==control || control.readyState!==WebSocket.OPEN)return;
          control.send(JSON.stringify({version:'1.0',type:'split_reconnect',sessionId:this.o.session()}));
        },this.backoff);
        this.backoff=Math.min(5000,this.backoff*2);
      };
      socket.binaryType='arraybuffer';
      socket.onopen=()=>{if(current()){this.cancelTimer();this.backoff=500;this.o.event('media-open');}};
      socket.onmessage=e=>{if(current() && e.data instanceof ArrayBuffer)this.o.frame(e.data);};
      socket.onerror=socket.onclose=retry;
      this.timer=setTimeout(retry,10000);
      return true;
    }
  }
  root.KarCastSplitMediaClient=SplitMediaClient;
})(typeof window==='undefined'?globalThis:window);
