(function(){
'use strict';
const LS={
  get(k){try{const v=localStorage.getItem(k);return v?JSON.parse(v):null}catch(e){return null}},
  set(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}},
  del(k){try{localStorage.removeItem(k)}catch(e){}}
};
const TEAM_COLORS=['#FF5A36','#3A8DFF','#3DDC84','#D63DFF','#FFB020','#22D3D3','#9B7BFF','#FF4FA3','#6E9BFF','#FF6B7A'];
const PHASES={setup:'Бэлтгэл',register:'Бүртгэл',order:'Дараалал',draft:'Драфт',play:'Тоглолт',tiebreak:'Тэнцээ шийдвэрлэх',finished:'Эцсийн дүн'};
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid=()=>Math.random().toString(36).slice(2,10);
function shuffle(a){a=a.slice();for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a}
const reduced=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- дуу ---------- */
const sfx=(()=>{
  let ctx=null,muted=LS.get('tq-mute')===true;
  function c(){if(!ctx){try{ctx=new (window.AudioContext||window.webkitAudioContext)()}catch(e){}}if(ctx&&ctx.state==='suspended')ctx.resume();return ctx}
  function tone(f,d,type,v,when){if(muted)return;const a=c();if(!a)return;const o=a.createOscillator(),g=a.createGain();o.type=type||'sine';o.frequency.value=f;const t=a.currentTime+(when||0);g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(v||.12,t+.01);g.gain.exponentialRampToValueAtTime(.0001,t+d);o.connect(g).connect(a.destination);o.start(t);o.stop(t+d+.05)}
  return {
    count(){tone(660,.18,'square',.07)},
    go(){tone(880,.12,'triangle',.14);tone(1320,.3,'triangle',.12,.1)},
    tick(){tone(1200,.05,'sine',.05)},
    buzz(){tone(150,.55,'sawtooth',.1);tone(110,.55,'sawtooth',.08,.05)},
    win(){[523,659,784,1046].forEach((f,i)=>tone(f,.3,'triangle',.11,i*.1))},
    fanfare(){[523,659,784,1046,784,1046,1318].forEach((f,i)=>tone(f,.35,'triangle',.11,i*.13))},
    pop(){tone(520,.08,'sine',.08);tone(780,.1,'sine',.06,.05)},
    unlock(){c()},
    get muted(){return muted},
    toggle(){muted=!muted;LS.set('tq-mute',muted)}
  };
})();

/* ---------- confetti ---------- */
const confetti=(()=>{
  const cv=document.getElementById('fx'),x=cv.getContext('2d');let parts=[],run=false;
  function size(){const d=devicePixelRatio||1;cv.width=innerWidth*d;cv.height=innerHeight*d}
  addEventListener('resize',size);size();
  function burst(n,ox,oy){
    if(reduced())return;const d=devicePixelRatio||1;
    const cols=['#FFC53D','#FF3D9A','#2DE2E6','#7C5CFF','#FFFFFF','#3DDC84'];
    for(let i=0;i<(n||120);i++){const a=Math.random()*Math.PI*2,s=4+Math.random()*10;
      parts.push({x:(ox==null?.5:ox)*cv.width,y:(oy==null?.35:oy)*cv.height,vx:Math.cos(a)*s*d,vy:(Math.sin(a)*s-7)*d,r:(3+Math.random()*5)*d,c:cols[i%cols.length],rot:Math.random()*6,vr:(Math.random()-.5)*.35,life:0})}
    if(!run){run=true;requestAnimationFrame(loop)}
  }
  function rain(){for(let i=0;i<5;i++)setTimeout(()=>burst(90,.15+Math.random()*.7,.1+Math.random()*.3),i*350)}
  function loop(){
    const d=devicePixelRatio||1;x.clearRect(0,0,cv.width,cv.height);
    parts=parts.filter(p=>p.life<260&&p.y<cv.height+40);
    for(const p of parts){p.life++;p.vy+=.22*d;p.vx*=.99;p.x+=p.vx;p.y+=p.vy;p.rot+=p.vr;x.save();x.translate(p.x,p.y);x.rotate(p.rot);x.globalAlpha=Math.max(0,1-p.life/260);x.fillStyle=p.c;x.fillRect(-p.r,-p.r/2,p.r*2,p.r);x.restore()}
    if(parts.length)requestAnimationFrame(loop);else{run=false;x.clearRect(0,0,cv.width,cv.height)}
  }
  return {burst,rain};
})();

/* ---------- холболт ---------- */
const socket=io();
const S={connected:false,auth:null,authTried:false,viewAs:'admin',view:null,setup:null,setupPending:0,form:{},grade:{},
  offset:0,lastPhase:null,gameId:null,seenUsed:new Set(),seenPicks:new Set(),revealed:new Set(),shownScores:{},logLen:0,tbDone:new Set(),orderShown:null};
const now=()=>Date.now()+S.offset;

let toastTimer=null;
function toast(msg){const t=document.getElementById('toast');t.hidden=true;void t.offsetWidth;t.textContent=msg;t.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{t.hidden=true},3600)}
function send(type,data,quiet){
  return new Promise(res=>{
    if(!S.connected){if(!quiet)toast('Сервертэй холбогдоогүй байна.');return res({ok:false})}
    socket.emit('act',Object.assign({type},data||{}),r=>{r=r||{ok:false};if(!r.ok&&!quiet)toast(r.error||'Алдаа гарлаа.');res(r)});
  });
}
function auth(code,silent){
  socket.emit('auth',code,r=>{
    S.authTried=true;
    if(r&&r.ok){S.auth=r.role;S.viewAs='admin';LS.set('tq-code',code);S.form.code='';S.lastPhase=null}
    else{
      S.auth=null;S.form.code='';LS.del('tq-code');
      if(!silent){toast((r&&r.error)||'Код буруу байна.');setTimeout(()=>{const c=document.querySelector('.login .card');if(c){c.classList.remove('shake');void c.offsetWidth;c.classList.add('shake')}},0)}
    }
    render();
  });
}
socket.on('connect',()=>{S.connected=true;const c=LS.get('tq-code');if(c)auth(c,true);else{S.authTried=true;render()}});
socket.on('disconnect',()=>{S.connected=false;render()});
socket.on('state',v=>{
  if(v.serverNow)S.offset=v.serverNow-Date.now();
  const prev=S.view&&S.view.game,g=v.game;
  if(g&&g.id!==S.gameId){
    // анх ачаалах эсвэл шинэ тоглоом: өмнөх үйлдлүүдийг хөдөлгөөнгүйгээр тэмдэглэнэ
    S.gameId=g.id;S.seenUsed=new Set(Object.keys(g.used||{}));S.seenPicks=new Set(g.draft.picks.map(p=>p.capId+':'+p.name));
    S.revealed=new Set();S.shownScores=Object.assign({},g.scores||{});S.logLen=(g.log||[]).length;S.tbDone=new Set();
    const c=g.play.current;if(c&&(c.status==='done'||now()>c.startAt+1500))S.revealed.add(c.key);
    if(g.tiebreak&&g.tiebreak.status==='done')S.tbDone.add(g.tiebreak.key);
  }else if(g&&prev){celebrate(prev,g)}
  S.view=v;if(v.setup&&!S.setupPending)S.setup=v.setup;render();
});
socket.on('loggedout',msg=>{S.auth=null;S.view=null;LS.del('tq-code');toast(msg||'Гарлаа.');render()});

function celebrate(prev,g){
  const role=currentRole();
  if((g.log||[]).length>S.logLen){
    const last=g.log[g.log.length-1];S.logLen=g.log.length;
    const winners=Object.keys(last.results||{}).filter(id=>last.results[id]>0);
    if(winners.length){
      const mine=winners.includes(role),isCap=!!g.captains[role];
      if(mine||!isCap){confetti.burst(mine?220:120);sfx.win()}
    }
  }
  if(g.tiebreak&&g.tiebreak.status==='done'&&!S.tbDone.has(g.tiebreak.key)){S.tbDone.add(g.tiebreak.key);if(Object.values(g.tiebreak.results||{}).some(Boolean)){confetti.burst(120);sfx.win()}}
  if(g.phase==='finished'&&prev.phase!=='finished')setTimeout(()=>{confetti.rain();sfx.fanfare()},900);
  if(g.draft.picks.length>prev.draft.picks.length)sfx.pop();
}

let setupTimer=null,setupSeq=0;
function pushSetup(){
  const my=++setupSeq;S.setupPending=1;clearTimeout(setupTimer);
  setupTimer=setTimeout(async()=>{await send('setup.update',{setup:S.setup});if(my===setupSeq)S.setupPending=0},400);
}

/* ---------- тооцоолол ---------- */
const G=()=>S.view&&S.view.game;
const capName=(st,id)=>(st.captains[id]&&st.captains[id].name)||'?';
const teamColor=(st,id)=>TEAM_COLORS[Math.max(0,st.captainIds.indexOf(id))%TEAM_COLORS.length];
const teamIds=st=>st.order&&st.order.length?st.order:st.captainIds;
function draftInfo(st){
  const order=teamIds(st),n=order.length,picks=st.draft.picks||[];
  const caps=new Set(st.captainIds.map(id=>st.captains[id].name));
  const picked=new Set(picks.map(p=>p.name));
  const pool=st.participants.filter(p=>!caps.has(p)&&!picked.has(p));
  const k=picks.length,r=Math.floor(k/n),pos=k%n,idx=r%2===0?pos:n-1-pos;
  const teams={};order.forEach(id=>teams[id]=[]);
  picks.forEach(p=>{(teams[p.capId]||(teams[p.capId]=[])).push(p.name)});
  return {pool,picker:pool.length?order[idx]:null,teams,k,r,total:k+pool.length,dir:r%2===0?1:-1};
}
function cmpTb(a,b){const L=Math.max(a.length,b.length);for(let i=0;i<L;i++){const x=a[i]==null?-1:a[i],y=b[i]==null?-1:b[i];if(x!==y)return x-y}return 0}
function rankInfo(st){
  const arr=teamIds(st).map(id=>({id,score:(st.scores||{})[id]||0,tb:((st.tb||{})[id])||[]}));
  arr.sort((a,b)=>(b.score-a.score)||cmpTb(b.tb,a.tb));
  const groups=[];
  for(let i=0;i<arr.length;){let j=i+1;
    while(j<arr.length&&arr[j].score===arr[i].score&&cmpTb(arr[j].tb,arr[i].tb)===0)j++;
    for(let k=i;k<j;k++)arr[k].place=i+1;
    if(j-i>1)groups.push(arr.slice(i,j).map(x=>x.id));
    i=j}
  return {list:arr,groups};
}
const eligible=(st,capId)=>st.answerMode==='picker'?[capId]:teamIds(st).slice();
const ansOf=(st,key,capId)=>{const a=st.answers&&st.answers[key];return a&&a[capId]!=null?a[capId]:null};
const topicName=(st,tid)=>{const t=st.topics.find(x=>x.id===tid);return t?t.name:''};
const remainingQ=st=>st.qmeta.filter(q=>!(st.used||{})[q.id]);
function activeQ(){const st=G();if(!st)return null;if(st.phase==='play')return st.play.current;if(st.phase==='tiebreak')return st.tiebreak;return null}
function qState(cur){if(!cur)return null;if(cur.status==='done')return 'done';const t=now();if(cur.startAt&&t<cur.startAt)return 'countdown';if(cur.endAt&&t>=cur.endAt)return 'over';return 'running'}

function currentRole(){
  const st=G();
  if(S.auth==='admin'){
    if(S.viewAs==='admin'||S.viewAs==='spectator')return S.viewAs;
    if(st&&st.captains[S.viewAs])return S.viewAs;
    return 'admin';
  }
  return S.auth;
}

/* ---------- зурах ---------- */
function captureFocus(){const el=document.activeElement;if(el&&el.id){let s=null,e=null;try{s=el.selectionStart;e=el.selectionEnd}catch(x){}return {id:el.id,s,e}}return null}
function restoreFocus(f){if(!f)return;const el=document.getElementById(f.id);if(!el)return;el.focus({preventScroll:true});try{if(f.s!=null)el.setSelectionRange(f.s,f.e)}catch(x){}}
const fv=(k,d)=>esc(S.form[k]!=null?S.form[k]:(d==null?'':d));
function flipCapture(){const m=new Map();document.querySelectorAll('[data-flip]').forEach(el=>m.set(el.dataset.flip,el.getBoundingClientRect().top));return m}
function flipPlay(m){if(reduced())return;document.querySelectorAll('[data-flip]').forEach(el=>{const t0=m.get(el.dataset.flip);if(t0==null)return;const dy=t0-el.getBoundingClientRect().top;if(Math.abs(dy)>2)el.animate([{transform:`translateY(${dy}px)`},{transform:'none'}],{duration:700,easing:'cubic-bezier(.2,.8,.2,1)'})})}
function countUps(){
  document.querySelectorAll('[data-count]').forEach(el=>{
    const id=el.dataset.count,to=Number(el.dataset.to),from=S.shownScores[id]==null?to:S.shownScores[id];
    S.shownScores[id]=to;
    if(from===to||reduced()){el.textContent=to;return}
    el.classList.add('bump');const t0=performance.now(),dur=900;
    (function step(t){const k=Math.min(1,(t-t0)/dur),e=1-Math.pow(1-k,3);el.textContent=Math.round(from+(to-from)*e);if(k<1)requestAnimationFrame(step)})(t0);
  });
}

function render(){
  const f=captureFocus(),flips=flipCapture();
  const st=G(),phaseKey=(S.auth||'')+':'+(st?st.phase:'setup');
  const enter=S.lastPhase!==phaseKey;S.lastPhase=phaseKey;
  document.getElementById('root').innerHTML=renderTop()+(S.connected?'':'<div class="offline">Сервертэй холболт тасарсан. Дахин холбогдож байна…</div>')+`<main class="wrap ${enter?'enter':''} ${currentRole()==='spectator'?'spec':''}">`+renderMain()+'</main>';
  restoreFocus(f);flipPlay(flips);countUps();
  // шинээр ашиглагдсан хавтанг эргүүлэх
  requestAnimationFrame(()=>requestAnimationFrame(()=>document.querySelectorAll('.tile[data-flipnow]').forEach(el=>el.classList.add('used'))));
  tick(true);
}
function renderTop(){
  const st=G(),role=currentRole();
  let phase='',live=false;
  if(S.auth){
    if(st){phase=PHASES[st.phase]||'';if(st.phase==='play'){phase+=': '+st.play.round+'/'+st.rounds+' үе';live=true}if(st.phase==='tiebreak')live=true}
    else phase=PHASES.setup;
  }
  let right=`<button class="linkbtn" data-act="mute" aria-label="${sfx.muted?'Дуу асаах':'Дуу хаах'}" title="${sfx.muted?'Дуу асаах':'Дуу хаах'}">${sfx.muted?'🔇':'🔊'}</button>`;
  if(S.auth==='admin'){
    if(st)right+=`<select id="role-sel" aria-label="Харагдац">
      <option value="admin" ${role==='admin'?'selected':''}>Админ</option>
      ${st.captainIds.map(id=>`<option value="${id}" ${role===id?'selected':''}>Ахлагч: ${esc(capName(st,id))}</option>`).join('')}
      <option value="spectator" ${role==='spectator'?'selected':''}>Үзэгч / дэлгэц</option>
    </select>`;
    right+=`<button class="linkbtn" data-act="logout">Гарах</button>`;
  }else if(S.auth==='spectator'){
    right+=`<span class="who-pill">👀 Үзэгч</span><button class="linkbtn" data-act="logout">Гарах</button>`;
  }else if(S.auth&&st){
    right+=`<span class="who-pill"><span class="dot" style="--c:${teamColor(st,S.auth)}"></span>${esc(capName(st,S.auth))}</span><button class="linkbtn" data-act="logout">Гарах</button>`;
  }
  return `<header class="top"><div class="top-in"><div class="brand"><span class="mark"><span>?</span></span>Багийн квиз</div>${phase?`<span class="phase ${live?'live':''}">${esc(phase)}</span>`:''}<div class="top-right">${right}</div></div></header>`;
}
function renderLogin(){
  if(!S.authTried)return `<div class="empty">Холбогдож байна…</div>`;
  return `<div class="login"><div class="card"><div class="orb">🧠</div><h1 class="grad">Багийн квиз</h1><p class="muted">Нууц кодоо оруулна уу</p>
  <input type="password" id="f-code" class="codein" data-bind="code" inputmode="numeric" autocomplete="one-time-code" maxlength="12" value="${fv('code')}" autofocus aria-label="Нууц код">
  <button class="btn big" data-act="login">Нэвтрэх</button>
  <p class="muted small">Админ, багийн ахлагч эсвэл үзэгчийн код</p></div></div>`;
}
function renderMain(){
  if(!S.auth)return renderLogin();
  if(!S.view)return `<div class="empty">Ачаалж байна…</div>`;
  const st=G(),role=currentRole();
  if(role==='admin'){
    if(!st)return renderSetup();
    return renderAdmin(st);
  }
  if(!st)return `<div class="card empty"><h2 class="grad" style="font-size:26px">Тоглоом удахгүй эхэлнэ</h2><p style="margin-top:10px">Админ бэлтгэл хийж байна.</p></div>`;
  if(role==='spectator')return phaseView(st,'spectator');
  return renderCaptain(st,role);
}

/* ---------- бэлтгэл ---------- */
function renderSetup(){
  const b=S.setup;if(!b)return `<div class="empty">Ачаалж байна…</div>`;
  const topics=[...new Set(b.questions.map(q=>q.topic))];
  const caps=new Set(b.captainNames);
  const needed=b.rounds*b.captainNames.length;
  const issues=[];
  if(!b.questions.length)issues.push('Асуулт оруулаагүй байна.');
  if(b.participants.length<2)issues.push('Дор хаяж 2 оролцогч хэрэгтэй.');
  if(b.captainNames.length<2)issues.push('Дор хаяж 2 багийн ахлагч сонгоно уу.');
  if(b.captainNames.length>=2&&b.captainNames.length===b.participants.length)issues.push('Бүх оролцогч ахлагч байна. Драфтад сонгох гишүүн үлдэхгүй.');
  const warn=(b.captainNames.length>=2&&b.questions.length&&b.questions.length<needed)?`Асуулт хүрэлцэхгүй: ${b.rounds} үе × ${b.captainNames.length} баг = ${needed} асуулт хэрэгтэй, одоо ${b.questions.length} байна. Асуулт дуусахад тоглоом эрт дуусна.`:'';
  const qlist=topics.map(t=>`<div class="qgroup"><h3>${esc(t)}</h3>${b.questions.filter(q=>q.topic===t).sort((x,y)=>x.points-y.points).map(q=>`
    <div class="qrow"><span class="pts">${q.points}</span><div class="qtext"><div>${esc(q.q)}</div><div class="muted small">Хариулт: ${esc(q.a)}</div></div><button class="icon-btn" data-act="delq" data-id="${q.id}" aria-label="Асуулт устгах">✕</button></div>`).join('')}</div>`).join('');
  return `<div class="steps">
  <div><h1 class="grad" style="font-size:clamp(26px,4vw,36px);font-weight:900">Тоглоомын бэлтгэл</h1><p class="muted" style="margin-top:6px">Дөрвөн алхмыг бөглөөд бүртгэлээ нээнэ. Өөрчлөлт сервер дээр автоматаар хадгалагдана.</p></div>

  <section class="card">
    <div class="step-h"><span class="num">1</span><div><h2>Асуултууд</h2><p class="muted small">Сэдэв, оноо, асуулт, хариулт. Одоогоор ${b.questions.length} асуулт, ${topics.length} сэдэв.</p></div></div>
    <datalist id="topic-list">${topics.map(t=>`<option value="${esc(t)}">`).join('')}</datalist>
    <div class="qform">
      <label class="f">Сэдэв<input type="text" id="f-topic" data-bind="topic" list="topic-list" value="${fv('topic')}" placeholder="Жишээ нь: Түүх"></label>
      <label class="f">Оноо<input type="number" id="f-points" data-bind="points" min="1" step="1" value="${fv('points','100')}"></label>
      <label class="f wide">Асуулт<textarea id="f-q" data-bind="q" rows="2">${fv('q')}</textarea></label>
      <label class="f wide">Зөв хариулт<input type="text" id="f-a" data-bind="a" value="${fv('a')}"></label>
      <div class="wide row"><button class="btn" data-act="addq">Асуулт нэмэх</button><button class="btn ghost" data-act="sample">Жишээ асуултаар дүүргэх</button>${b.questions.length?`<span class="spacer"></span><button class="btn danger" data-act="clearq">Бүгдийг устгах</button>`:''}</div>
    </div>
    <details ${S.form.bulkOpen?'open':''}><summary>Олноор нь хуулж оруулах, хуулбар авах</summary>
      <p class="muted small" style="margin:8px 0">Мөр бүрт нэг асуулт: <b>Сэдэв | Оноо | Асуулт | Хариулт</b>. Excel-ээс хуулсан табаар тусгаарласан мөр ч болно.</p>
      <textarea id="f-bulk" data-bind="bulk" rows="5" placeholder="Түүх | 100 | Их Монгол Улс хэдэн онд байгуулагдсан бэ? | 1206">${fv('bulk')}</textarea>
      <div class="row" style="margin-top:8px"><button class="btn sec" data-act="bulk">Оруулах</button>${b.questions.length?'<button class="btn ghost" data-act="exportq">Одоогийн асуултуудыг энд гаргах</button>':''}</div>
    </details>
    ${qlist}
  </section>

  <section class="card">
    <div class="step-h"><span class="num">2</span><div><h2>Оролцогчид</h2><p class="muted small">Мөр бүрт нэг нэр. Ахлагч нар ч энд багтана. Одоогоор ${b.participants.length} хүн.</p></div></div>
    <textarea id="f-people" data-bind="people" rows="6" placeholder="Бат&#10;Сараа&#10;Тэмүүлэн">${fv('people',b.participants.join('\n'))}</textarea>
    <div class="row" style="margin-top:10px"><button class="btn sec" data-act="savepeople">Нэрсийг хадгалах</button></div>
  </section>

  <section class="card">
    <div class="step-h"><span class="num">3</span><div><h2>Үеийн тоо, хугацаа</h2><p class="muted small">Нэг үед баг бүр нэг удаа асуулт сонгоно. Асуулт сонгогдмогц 3, 2, 1 гэж тоолоод хугацаа эхэлнэ.</p></div></div>
    <div class="row" style="align-items:flex-end;gap:24px">
      <label class="f" style="max-width:130px">Үе<input type="number" id="f-rounds" min="1" max="50" value="${b.rounds}"></label>
      <label class="f" style="max-width:190px">Хариулах хугацаа (сек)<input type="number" id="f-time" min="5" max="600" value="${b.timeLimit||30}"></label>
      <div style="display:grid;gap:6px">
        <span class="muted small">Сонгосон асуултад хэн хариулах вэ?</span>
        <label class="radio"><input type="radio" name="amode" value="all" ${b.answerMode!=='picker'?'checked':''}> Бүх баг хариулна</label>
        <label class="radio"><input type="radio" name="amode" value="picker" ${b.answerMode==='picker'?'checked':''}> Зөвхөн сонгосон баг хариулна</label>
      </div>
    </div>
  </section>

  <section class="card">
    <div class="step-h"><span class="num">4</span><div><h2>Багийн ахлагч нар</h2><p class="muted small">Нэр дээр дарж ахлагчаар тэмдэглэнэ. Сонгосон: ${b.captainNames.length}.</p></div></div>
    ${b.participants.length?`<div class="chips">${b.participants.map(p=>`<button class="chip ${caps.has(p)?'on':''}" data-act="togglecap" data-name="${esc(p)}" aria-pressed="${caps.has(p)}">${esc(p)}</button>`).join('')}</div>
    <div class="row" style="margin-top:12px"><input type="number" id="f-capcount" data-bind="capcount" min="2" style="width:90px" value="${fv('capcount','4')}"><button class="btn ghost" data-act="randcap">Санамсаргүй сонгох</button></div>`:`<p class="muted">Эхлээд оролцогчдын нэрсийг оруулна уу.</p>`}
  </section>

  <section class="card">
    <div class="issues">${issues.map(i=>`<div class="bad">${esc(i)}</div>`).join('')}${warn?`<div class="warn">${esc(warn)}</div>`:''}</div>
    <div class="row" style="margin-top:${issues.length||warn?'12px':'0'}"><button class="btn big" data-act="startreg" ${issues.length?'disabled':''}>Бүртгэл нээх</button>
    <span class="muted small">Ахлагч бүрд санамсаргүй 6 оронтой код үүснэ.</span></div>
  </section>
  </div>`;
}

/* ---------- нийтлэг хэсгүүд ---------- */
function renderBoard(st,opts){
  opts=opts||{};
  const cur=st.play&&st.play.current;
  let d=0;
  const cols=st.topics.map(t=>{
    const qs=st.qmeta.filter(q=>q.topic===t.id).sort((a,b)=>a.points-b.points);
    return `<div class="col"><div class="topic">${esc(t.name)}</div>${qs.map(q=>{
      const used=(st.used||{})[q.id],sel=cur&&cur.qid===q.id&&cur.status!=='done',can=opts.clickable&&!used&&!cur;
      const fresh=used&&!sel&&!S.seenUsed.has(q.id);if(used&&!sel)S.seenUsed.add(q.id);
      const cls=(used&&!sel&&!fresh?'used ':'')+(sel?'sel ':'')+(can?'can':'');
      return `<button class="tile ${cls}" style="--d:${d++}" ${fresh?'data-flipnow':''} ${can?`data-act="pickq" data-q="${q.id}"`:'tabindex="-1"'} aria-label="${esc(t.name)}, ${q.points} оноо${used?', ашигласан':''}"><span class="in"><span class="fr">${q.points}</span><span class="bk">✓</span></span></button>`}).join('')}</div>`}).join('');
  return `<div class="board-wrap"><div class="board">${cols}</div>${opts.note?`<p class="board-note">${opts.note}</p>`:''}</div>`;
}
function topicSummary(st){
  return `<div class="card"><h2>Сэдвүүд</h2><div style="display:grid;gap:8px;margin-top:10px">${st.topics.map(t=>{
    const qs=st.qmeta.filter(q=>q.topic===t.id);const by={};qs.forEach(q=>by[q.points]=(by[q.points]||0)+1);
    return `<div class="row"><b style="min-width:140px">${esc(t.name)}</b><span class="muted small">${Object.keys(by).sort((a,b)=>a-b).map(p=>`${p} оноо × ${by[p]}`).join(', ')}</span></div>`}).join('')}</div>
    <p class="muted small" style="margin-top:12px">Нийт ${st.qmeta.length} асуулт, ${st.rounds} үе, асуулт бүрт ${st.timeLimit} секунд.</p></div>`;
}
function renderScoreboard(st){
  const r=rankInfo(st),teams=draftInfo(st).teams;
  return `<div class="card"><h2 style="margin-bottom:10px">Онооны самбар</h2><div class="score-list">${r.list.map(x=>`
    <div class="srow p${x.place}" data-flip="s-${x.id}"><span class="place">${x.place}</span><div><div class="sname"><span class="dot" style="--c:${teamColor(st,x.id)}"></span>${esc(capName(st,x.id))}-ийн баг</div>${(teams[x.id]||[]).length?`<div class="members">${teams[x.id].map(esc).join(', ')}</div>`:''}</div><span class="sval" data-count="${x.id}" data-to="${x.score}">${S.shownScores[x.id]==null?x.score:S.shownScores[x.id]}</span></div>`).join('')}</div></div>`;
}
function renderOrder(st){
  const key=st.id+st.order.join();const anim=S.orderShown!==key;S.orderShown=key;
  return `<div class="card"><h2>Ахлагч нарын дараалал</h2><p class="muted small" style="margin:4px 0 14px">Санамсаргүйгээр сугалсан. Драфт болон асуулт сонголт энэ дарааллаар явна.</p>
  <div class="order-list ${anim?'anim':''}">${st.order.map((id,i)=>`<div class="oitem" style="--c:${teamColor(st,id)};--i:${i}"><span class="n">${i+1}</span><span class="nm">${esc(capName(st,id))}</span></div>`).join('')}</div></div>`;
}
function regStatus(st){
  return `<div class="status-list">${st.captainIds.map(id=>{const c=st.captains[id];return `<div><span class="dot" style="--c:${teamColor(st,id)}"></span><span>${esc(c.name)}</span>${c.registered?'<span class="okmark">✓ нэвтэрсэн</span>':'<span class="waitmark">хүлээгдэж байна</span>'}</div>`}).join('')}</div>`;
}
function codeList(st){
  return `<div class="codes">${st.captainIds.map(id=>{const c=st.captains[id];return `<div class="crow"><span class="dot" style="--c:${teamColor(st,id)}"></span><b>${esc(c.name)}</b>${c.registered?'<span class="okmark small">✓ нэвтэрсэн</span>':'<span class="waitmark small">хүлээгдэж байна</span>'}<span class="code">${esc(c.code||'')}</span><button class="icon-btn" data-act="newcode" data-cap="${id}" title="Шинэ код үүсгэх" aria-label="${esc(c.name)}-ийн кодыг шинэчлэх">↻</button></div>`}).join('')}</div>`;
}

function renderDraft(st,role){
  const d=draftInfo(st),canPick=d.picker&&(role==='admin'||role===d.picker);
  const head=d.picker
    ?`<div class="turn" style="--c:${teamColor(st,d.picker)}"><div style="flex:1"><div class="muted small">Сонголт ${d.k+1} / ${d.total}</div><div class="who">${role===d.picker?'Таны ээлж: гишүүнээ сонгоно уу':esc(capName(st,d.picker))+' сонгож байна'}</div></div><span class="roundinfo">${d.r+1}-р тойрог ${d.dir>0?'1 → '+st.order.length:st.order.length+' → 1'}</span></div>`
    :`<div class="turn"><div class="who">Драфт дууслаа 🎉</div></div>`;
  const pool=d.pool.length?`<div class="card"><h2 style="margin-bottom:12px">Сонгогдоогүй оролцогчид</h2><div class="chips pool">${d.pool.map(p=>canPick?`<button class="chip pick" data-act="draftpick" data-name="${esc(p)}">${esc(p)}</button>`:`<span class="chip idle">${esc(p)}</span>`).join('')}</div>${role==='admin'&&canPick?`<p class="muted small" style="margin-top:10px">Админ дарвал ${esc(capName(st,d.picker))}-ийн өмнөөс сонгоно.</p>`:''}</div>`:'';
  const teams=`<div class="teams">${st.order.map(id=>`<div class="team ${d.picker===id?'active':''}" style="--c:${teamColor(st,id)}"><h3><span class="dot" style="--c:${teamColor(st,id)}"></span>${esc(capName(st,id))}-ийн баг</h3><div class="cap">Ахлагч: ${esc(capName(st,id))}</div>${d.teams[id].length?`<ul>${d.teams[id].map(n=>{const k=id+':'+n,fresh=!S.seenPicks.has(k);S.seenPicks.add(k);return `<li class="${fresh?'pop':''}">${esc(n)}</li>`}).join('')}</ul>`:'<div class="muted small">Гишүүнгүй</div>'}</div>`).join('')}</div>`;
  let admin='';
  if(role==='admin')admin=`<div class="row">${!d.picker?`<button class="btn big" data-act="startplay">Тоглоом эхлүүлэх</button>`:''}${d.k?`<button class="btn ghost" data-act="undopick">Сүүлийн сонголтыг буцаах</button>`:''}</div>`;
  return `<div class="stack">${head}${admin}${pool}${teams}</div>`;
}

function gradeControls(key,capId,points,isTb){
  const g=(S.grade[key]||{})[capId];
  if(isTb)return `<div class="grade"><button class="gbtn ok ${g===1?'on':''}" data-act="grade" data-key="${key}" data-cap="${capId}" data-v="1">Зөв</button><button class="gbtn no ${g===0?'on':''}" data-act="grade" data-key="${key}" data-cap="${capId}" data-v="0">Буруу</button></div>`;
  const custom=g!=null&&g!==points&&g!==0;
  return `<div class="grade"><button class="gbtn ok ${g===points?'on':''}" data-act="grade" data-key="${key}" data-cap="${capId}" data-v="${points}">Зөв +${points}</button><button class="gbtn no ${g===0?'on':''}" data-act="grade" data-key="${key}" data-cap="${capId}" data-v="0">Буруу 0</button><input type="number" id="pts-${key}-${capId}" data-grade-key="${key}" data-grade-cap="${capId}" placeholder="Өөр оноо" value="${custom?g:''}" aria-label="Өөр оноо"></div>`;
}
const RING=2*Math.PI*32;
function timerHtml(){
  return `<div class="timer" data-timer><svg viewBox="0 0 76 76" aria-hidden="true"><circle class="bg" cx="38" cy="38" r="32" fill="none" stroke-width="7"/><circle class="fg" cx="38" cy="38" r="32" fill="none" stroke-width="7" stroke-dasharray="${RING.toFixed(1)}" stroke-dashoffset="0"/></svg><div class="t">–</div></div>`;
}

function renderQuestion(st,cur,role,isTb){
  const elig=isTb?cur.group:eligible(st,cur.capId);
  const qs=qState(cur),done=qs==='done';
  const meta=isTb
    ?`<div class="qmeta"><span class="pts" style="background:linear-gradient(135deg,var(--pink),var(--violet));color:#fff">Шийдвэрлэх</span>${cur.topicName?`<span>${esc(cur.topicName)}</span>`:''}<span>${cur.group.map(id=>esc(capName(st,id))).join(' ба ')}</span></div>`
    :`<div class="qmeta"><span class="pts">${cur.points}</span><span>${esc(topicName(st,cur.topic))}</span><span>Сонгосон: ${esc(capName(st,cur.capId))}</span></div>`;
  let revealCls='';
  if(qs!=='countdown'&&cur.text&&!S.revealed.has(cur.key)){S.revealed.add(cur.key);revealCls='reveal-in'}
  const textHtml=qs==='countdown'&&role!=='admin'?`<div class="qbody hidden">Асуулт нээгдэх гэж байна…</div>`:`<div class="qbody ${revealCls}">${esc(cur.text||'')}</div>`;
  let body='';
  if(role==='admin'){
    body+=`<div class="reveal"><div class="lbl">${done?'Зөв хариулт':'Зөв хариулт (зөвхөн админд)'}</div><div class="val">${esc(cur.answer)||'—'}</div></div>`;
    if(!done&&qs!=='over')body+=`<div class="row"><button class="btn sec" data-act="timeadd">+10 секунд</button><button class="btn sec" data-act="timestop">Хугацааг одоо дуусгах</button></div>`;
    else if(!done)body+=`<div class="row"><button class="btn sec" data-act="timeadd">Хугацааг 10 секундээр сунгах</button></div>`;
    body+=`<div class="alist">${elig.map(id=>{const a=ansOf(st,cur.key,id);const res=done&&cur.results?cur.results[id]:null;
      return `<div class="arow ${done?(res>0?'right':'wrong'):''}" style="--c:${teamColor(st,id)}"><div class="t"><span class="dot" style="--c:${teamColor(st,id)}"></span>${esc(capName(st,id))}-ийн баг${done?`<span class="spacer"></span><span class="awarded">${isTb?(res?'Зөв ✓':'Буруу'):(res>=0?'+':'')+(res||0)}</span>`:''}</div>
      <div class="ans">${a!=null?esc(a):`<span class="muted">${qs==='over'||done?'Хариулаагүй':'Хүлээж байна…'}</span>`}</div>${done?'':gradeControls(cur.key,id,cur.points,isTb)}</div>`}).join('')}</div>`;
    if(!done){
      const g=S.grade[cur.key]||{},ready=elig.every(id=>g[id]!=null);
      body+=`<div class="row"><button class="btn" data-act="${isTb?'tbjudge':'award'}" ${ready?'':'disabled'}>${isTb?'Дүгнэх':'Оноо өгөх'}</button>${isTb?'':'<button class="btn ghost" data-act="cancelq">Асуултыг буцаах</button>'}${ready?'':'<span class="muted small">Баг бүрийг тэмдэглэнэ үү</span>'}</div>`;
    }else if(!isTb){
      body+=`<div class="row"><button class="btn big cyan" data-act="next">Дараагийн ээлж</button></div>`;
    }
  }else{
    if(done){
      body+=`<div class="reveal pop"><div class="lbl">Зөв хариулт</div><div class="val">${esc(cur.answer)||'—'}</div></div>`;
      body+=`<div class="alist">${elig.map(id=>{const a=ansOf(st,cur.key,id);const res=cur.results?cur.results[id]:0;
        return `<div class="arow ${res>0?'right':'wrong'}" style="--c:${teamColor(st,id)}"><div class="t"><span class="dot" style="--c:${teamColor(st,id)}"></span>${esc(capName(st,id))}-ийн баг${id===role?' (та)':''}<span class="spacer"></span><span class="awarded">${isTb?(res?'Зөв ✓':'Буруу'):(res>=0?'+':'')+(res||0)}</span></div><div class="ans">${a!=null?esc(a):'<span class="muted">Хариулаагүй</span>'}</div></div>`}).join('')}</div>`;
    }else if(role&&st.captains[role]&&elig.includes(role)){
      const a=ansOf(st,cur.key,role),k='ans:'+cur.key+':'+role;
      if(qs==='countdown')body+=`<p class="muted">Бэлэн байгаарай…</p>`;
      else if(qs==='running'){
        body+=`<label class="f"><span class="muted">Багийн хариулт <span class="small">(бичсэн нь автоматаар хадгалагдана)</span></span><textarea id="ans-${cur.key}" data-bind="${k}" data-anskey="${cur.key}" rows="2" placeholder="Хариултаа бичнэ үү">${fv(k,a||'')}</textarea></label>
        <div class="row"><button class="btn" data-act="sendans" data-key="${cur.key}">${a!=null?'Хариултаа шинэчлэх':'Хариулт илгээх'}</button>${a!=null?`<span class="saved">✓ Хадгалагдсан: ${esc(a)}</span>`:''}</div>`;
      }else{
        body+=`<div class="lockmsg">⏱ Хугацаа дууссан. Хариулт өгөх, өөрчлөх боломжгүй.</div><div class="sent">Таны хариулт: ${a!=null?esc(a):'илгээгээгүй'}</div>`;
      }
    }else if(role&&st.captains[role]){
      body+=`<p class="muted">Энэ асуултад ${elig.map(id=>esc(capName(st,id))).join(', ')}-ийн баг хариулна.</p>`;
    }else{
      body+=`<p class="muted">${qs==='over'?'Хугацаа дууслаа. Админ дүгнэж байна…':qs==='countdown'?'Бэлтгэ…':'Багууд хариултаа бичиж байна…'}</p>`;
    }
  }
  return `<div class="qcard" data-qcard><div class="qhead">${meta}${done?'':timerHtml()}</div>${textHtml}${body}</div>`;
}

function renderPlay(st,role){
  const p=st.play,picker=st.order[p.turn],cur=p.current;
  const canPick=!cur&&(role==='admin'||role===picker);
  let who;
  if(cur)who=esc(capName(st,cur.capId))+'-ийн баг сонголоо';
  else if(role===picker)who='Таны ээлж: сэдэв, асуултаа сонгоно уу ✨';
  else who=esc(capName(st,picker))+'-ийн баг сонгож байна…';
  const head=`<div class="turn" style="--c:${teamColor(st,picker)}"><div style="flex:1"><div class="who">${who}</div>${role==='admin'&&canPick?`<div class="muted small">Самбар дээр дарвал ${esc(capName(st,picker))}-ийн өмнөөс сонгоно.</div>`:''}</div><span class="roundinfo">${p.round}/${st.rounds} үе</span></div>`;
  const left=`<div class="stack">${head}${cur?renderQuestion(st,cur,role,false):''}${renderBoard(st,{clickable:canPick})}${role==='admin'?`<div class="row"><button class="btn ghost" data-act="forceend">Тоглоомыг одоо дуусгах</button></div>`:''}</div>`;
  return `<div class="play">${left}<div class="stack">${renderScoreboard(st)}</div></div>`;
}

function renderTiebreak(st,role){
  const r=rankInfo(st),tb=st.tiebreak;
  const groupsHtml=r.groups.length?r.groups.map(g=>`<div class="tbgroup">${g.map(id=>`<span class="dot" style="--c:${teamColor(st,id)}"></span>${esc(capName(st,id))}`).join(' <span class="muted">ба</span> ')}<span class="muted small">(${r.list.find(x=>x.id===g[0]).score} оноо)</span></div>`).join(''):'<p>Бүх байр тодорлоо.</p>';
  let admin='';
  if(role==='admin'&&(!tb||tb.status==='done')){
    if(r.groups.length){
      admin=remainingQ(st).length===0
        ?`<div style="display:grid;gap:8px;margin-top:12px"><p class="muted small">Ашиглаагүй асуулт үлдээгүй. Шийдвэрлэх асуултаа бичнэ үү.</p><input type="text" id="f-tbq" data-bind="tbq" placeholder="Асуулт" value="${fv('tbq')}"><input type="text" id="f-tba" data-bind="tba" placeholder="Зөв хариулт" value="${fv('tba')}"><div><button class="btn" data-act="tbstart">Асуулт өгөх</button></div></div>`
        :`<div class="row" style="margin-top:12px"><button class="btn" data-act="tbstart">🎲 Санамсаргүй асуулт сугалах</button></div>`;
    }else admin=`<div class="row" style="margin-top:12px"><button class="btn big" data-act="tbfinish">🏆 Эцсийн дүн харах</button></div>`;
  }
  const card=`<div class="card"><h2>Тэнцсэн багууд</h2><p class="muted small" style="margin:4px 0 10px">Тэнцсэн багуудад санамсаргүй нэг асуулт өгч байрыг шийднэ.</p><div style="display:grid;gap:8px">${groupsHtml}</div>${admin}</div>`;
  return `<div class="play"><div class="stack">${card}${tb?renderQuestion(st,tb,role,true):''}</div><div class="stack">${renderScoreboard(st)}</div></div>`;
}

function renderFinal(st,role){
  const r=rankInfo(st),teams=draftInfo(st).teams;
  const top=r.list.slice(0,3),rest=r.list.slice(3);
  const order=[top[1],top[0],top[2]].filter(Boolean);
  const pod=x=>`<div class="pod pl${Math.min(x.place,3)}" style="--c:${teamColor(st,x.id)}">${x.place===1?'<div class="crown">👑</div>':''}<div class="pl">${x.place}</div><div class="nm">${esc(capName(st,x.id))}-ийн баг</div><div class="sc">${x.score} оноо</div><div class="members" style="margin-top:6px">${(teams[x.id]||[]).map(esc).join(', ')}</div></div>`;
  return `<div class="stack"><h1 class="final-title grad">Эцсийн дүн</h1>
  <div class="podium" style="${order.length<3?`grid-template-columns:repeat(${order.length},minmax(0,1fr));max-width:${order.length*300}px`:''}">${order.map(pod).join('')}</div>
  ${rest.length?renderScoreboard(st):''}
  ${role==='admin'?`<div class="row" style="justify-content:center"><button class="btn" data-act="celebrate">🎉 Дахин баярлах</button><button class="btn sec" data-act="newgame">Шинэ тоглоом</button></div>`:''}</div>`;
}

/* ---------- үүргийн харагдац ---------- */
function renderAdmin(st){
  let main='';
  if(st.phase==='register'){
    const all=st.captainIds.every(id=>st.captains[id].registered);
    main=`<div class="stack"><div class="card"><h2>Ахлагч нарын бүртгэл</h2><p class="muted small" style="margin:4px 0 14px">Ахлагч бүрд кодыг нь өгнө. Тэд сайт руу орж кодоо оруулахад нэвтэрсэн гэж тэмдэглэгдэнэ. Төхөөрөмжгүй ахлагчийн өмнөөс дээд талын «Харагдац» цэснээс үйлдэл хийж болно.</p>${codeList(st)}
    <div class="row" style="margin-top:16px"><button class="btn big" data-act="shuffleorder">🎲 Дараалал сугалах</button>${all?'':'<span class="muted small">Нэвтрээгүй ахлагч байна. Үргэлжлүүлж болно.</span>'}</div></div>${topicSummary(st)}</div>`;
  }else if(st.phase==='order'){
    const pool=draftInfo(st).pool.length;
    main=`<div class="stack">${renderOrder(st)}<div class="row"><button class="btn big" data-act="startdraft">${pool?'Драфт эхлүүлэх':'Тоглоом эхлүүлэх'}</button><button class="btn ghost" data-act="shuffleorder">Дахин сугалах</button></div>${renderBoard(st,{note:'Сэдэв бүрийн асуултууд онооны дагуу.'})}${topicSummary(st)}</div>`;
  }else if(st.phase==='draft')main=renderDraft(st,'admin');
  else if(st.phase==='play')main=renderPlay(st,'admin');
  else if(st.phase==='tiebreak')main=renderTiebreak(st,'admin');
  else if(st.phase==='finished')main=renderFinal(st,'admin');
  const codes=st.phase!=='register'&&st.phase!=='finished'?`<details style="width:100%"><summary>Ахлагч нарын кодууд</summary><div style="margin-top:10px">${codeList(st)}</div></details>`:'';
  return main+`<div class="foot">${codes}${st.phase==='finished'?'':'<button class="btn ghost" data-act="newgame">Тоглоомыг цуцалж бэлтгэл рүү буцах</button>'}</div>`;
}
function phaseView(st,role){
  if(st.phase==='register')return `<div class="card"><h2>Бүртгэл</h2><p class="muted small" style="margin:4px 0 12px">Бүх ахлагч нэвтэрсний дараа админ дарааллыг сугална.</p>${regStatus(st)}</div>`;
  if(st.phase==='order')return `<div class="stack">${renderOrder(st)}${renderBoard(st)}${topicSummary(st)}</div>`;
  if(st.phase==='draft')return renderDraft(st,role);
  if(st.phase==='play')return renderPlay(st,role);
  if(st.phase==='tiebreak')return renderTiebreak(st,role);
  if(st.phase==='finished')return renderFinal(st,role);
  return '';
}
function renderCaptain(st,id){
  return `<div class="stack"><div class="row"><span class="dot" style="--c:${teamColor(st,id)}"></span><b>${esc(capName(st,id))}-ийн багийн ахлагч</b></div>${phaseView(st,id)}</div>`;
}

/* ---------- цаг хэмжигч ---------- */
let tk={key:null,qs:null,n:null,sec:null};
function tick(fromRender){
  const cur=activeQ(),cd=document.getElementById('cd');
  if(!cur||!S.auth){cd.hidden=true;tk={key:null,qs:null,n:null,sec:null};return}
  const qs=qState(cur);
  if(cur.key!==tk.key){tk={key:cur.key,qs,n:null,sec:null}}
  else if(qs!==tk.qs){
    const prev=tk.qs;tk.qs=qs;
    if(qs==='running'&&prev==='countdown')sfx.go();
    if(qs==='over'&&prev==='running')sfx.buzz();
    if(!fromRender){render();return}
  }
  // 3-2-1
  if(qs==='countdown'){
    const n=Math.max(1,Math.ceil((cur.startAt-now())/1000));
    if(n!==tk.n){
      tk.n=n;sfx.count();
      const st=G();
      const lbl=cur.group?'Тэнцээ шийдвэрлэх асуулт':esc(capName(st,cur.capId))+'-ийн баг сонголоо';
      const meta=cur.group?cur.group.map(id=>esc(capName(st,id))).join(' ба '):`${esc(topicName(st,cur.topic))}, ${cur.points} оноо`;
      cd.innerHTML=`<div class="box"><div class="lbl">${lbl}</div><div class="meta">${meta}</div><div class="numwrap"><div class="ring"></div><div class="ring r2"></div><div class="n">${n}</div></div></div>`;
    }
    cd.hidden=false;
  }else cd.hidden=true;
  // цагираг
  const total=Math.max(1,cur.endAt-cur.startAt),left=Math.max(0,cur.endAt-now());
  const frac=qs==='countdown'?1:left/total,urgent=qs==='running'&&left<=5000;
  document.querySelectorAll('[data-timer]').forEach(el=>{
    el.querySelector('.fg').style.strokeDashoffset=(RING*(1-frac)).toFixed(1);
    el.classList.toggle('urgent',urgent);el.classList.toggle('over',qs==='over');
    el.querySelector('.t').textContent=qs==='over'?'Дууслаа':qs==='countdown'?Math.ceil(total/1000):Math.ceil(left/1000);
  });
  const card=document.querySelector('[data-qcard]');
  if(card)card.classList.toggle('urgent',urgent);
  if(urgent){const s=Math.ceil(left/1000);if(s!==tk.sec){tk.sec=s;if(!fromRender)sfx.tick()}}
}
setInterval(()=>tick(false),100);

/* ---------- үйлдлүүд ---------- */
const SAMPLE=[
  ['Түүх',100,'Их Монгол Улс хэдэн онд байгуулагдсан бэ?','1206 он'],
  ['Түүх',200,'Монгол Улс тусгаар тогтнолоо хэдэн онд тунхагласан бэ?','1911 он'],
  ['Түүх',300,'Хубилай хааны байгуулсан гүрэн юу гэж нэрлэгддэг вэ?','Юань гүрэн'],
  ['Газарзүй',100,'Монгол Улс хэдэн аймагтай вэ?','21'],
  ['Газарзүй',200,'Монголын хамгийн өндөр оргил аль нь вэ?','Хүйтэн оргил'],
  ['Газарзүй',300,'Талбайгаараа Монголын хамгийн том нуур аль нь вэ?','Увс нуур'],
  ['Шинжлэх ухаан',100,'Усны химийн томьёо юу вэ?','H₂O'],
  ['Шинжлэх ухаан',200,'Нарны аймгийн хамгийн том гариг аль нь вэ?','Бархасбадь'],
  ['Шинжлэх ухаан',300,'Вакуум дахь гэрлийн хурд секундэд ойролцоогоор хэдэн км вэ?','300 000 км'],
  ['Спорт',100,'Хөлбөмбөгийн нэг баг талбай дээр хэдэн тоглогчтой вэ?','11'],
  ['Спорт',200,'Эрийн гурван наадам гэж юуг хэлдэг вэ?','Бөх, морь уралдаан, сур харваа'],
  ['Спорт',300,'Монголын анхны олимпийн алтан медалийг хэн хүртсэн бэ?','Н. Түвшинбаяр (2008, жүдо)']
];
const asParam=()=>{const r=currentRole();return S.auth==='admin'&&r!=='admin'&&r!=='spectator'?{as:r}:{}};
let ansTimer=null;
const actions={
  login(){const c=(S.form.code||'').trim();if(!c)return toast('Кодоо оруулна уу.');sfx.unlock();auth(c,false)},
  logout(){socket.emit('logout');S.auth=null;S.view=null;LS.del('tq-code');render()},
  mute(){sfx.toggle();render()},
  celebrate(){confetti.rain();sfx.fanfare()},
  addq(){
    const f=S.form,topic=(f.topic||'').trim(),points=parseInt(f.points||'100',10),q=(f.q||'').trim(),a=(f.a||'').trim();
    if(!topic||!q||!a||!(points>0))return toast('Сэдэв, оноо, асуулт, хариултыг бүгдийг бөглөнө үү.');
    S.setup.questions.push({id:uid(),topic,points,q,a});S.form.q='';S.form.a='';pushSetup();render();
    const el=document.getElementById('f-q');if(el)el.focus();
  },
  bulk(){
    const lines=(S.form.bulk||'').split(/\r?\n/).map(l=>l.trim()).filter(Boolean);let n=0,bad=0;
    lines.forEach(l=>{const p=(l.includes('|')?l.split('|'):l.split('\t')).map(x=>x.trim());const pts=parseInt(p[1],10);
      if(p.length>=4&&p[0]&&pts>0&&p[2]&&p[3]){S.setup.questions.push({id:uid(),topic:p[0],points:pts,q:p[2],a:p.slice(3).join(' | ')});n++}else bad++});
    S.form.bulk='';S.form.bulkOpen=false;pushSetup();render();toast(`${n} асуулт нэмэгдлээ${bad?`, ${bad} мөр алгассан`:''}.`);
  },
  exportq(){S.form.bulk=S.setup.questions.map(q=>[q.topic,q.points,q.q,q.a].join(' | ')).join('\n');S.form.bulkOpen=true;render();toast('Текстийг хуулж өөр газар хадгалаарай.')},
  sample(){SAMPLE.forEach(s=>S.setup.questions.push({id:uid(),topic:s[0],points:s[1],q:s[2],a:s[3]}));pushSetup();render()},
  delq(b){S.setup.questions=S.setup.questions.filter(q=>q.id!==b.dataset.id);pushSetup();render()},
  clearq(){if(!confirm('Бүх асуултыг устгах уу?'))return;S.setup.questions=[];pushSetup();render()},
  savepeople(){
    const raw=S.form.people!=null?S.form.people:S.setup.participants.join('\n');
    const seen=new Set(),list=[];raw.split(/\r?\n|,/).map(x=>x.trim()).filter(Boolean).forEach(n=>{if(!seen.has(n)){seen.add(n);list.push(n)}});
    S.setup.participants=list;S.setup.captainNames=list.filter(n=>S.setup.captainNames.includes(n));S.form.people=list.join('\n');
    pushSetup();render();toast(`${list.length} оролцогч хадгалагдлаа.`);
  },
  togglecap(b){const n=b.dataset.name,set=new Set(S.setup.captainNames);set.has(n)?set.delete(n):set.add(n);S.setup.captainNames=S.setup.participants.filter(p=>set.has(p));pushSetup();render()},
  randcap(){const k=Math.max(2,Math.min(parseInt(S.form.capcount||'4',10)||2,S.setup.participants.length));const set=new Set(shuffle(S.setup.participants).slice(0,k));S.setup.captainNames=S.setup.participants.filter(p=>set.has(p));pushSetup();render()},
  async startreg(){
    clearTimeout(setupTimer);
    if(!(await send('setup.update',{setup:S.setup})).ok)return;
    S.setupPending=0;S.grade={};S.viewAs='admin';S.form={};
    send('game.start');
  },
  newcode(b){if(confirm('Энэ ахлагчийн кодыг шинэчлэх үү? Хуучин код ажиллахаа болино.'))send('captain.newcode',{capId:b.dataset.cap})},
  shuffleorder(){send('game.shuffle')},
  startdraft(){send('game.startdraft')},
  draftpick(b){send('draft.pick',Object.assign({name:b.dataset.name},asParam()))},
  undopick(){send('game.undopick')},
  startplay(){send('game.startplay')},
  pickq(b){send('play.pick',Object.assign({qid:b.dataset.q},asParam()))},
  grade(b){const k=b.dataset.key;S.grade[k]=S.grade[k]||{};S.grade[k][b.dataset.cap]=Number(b.dataset.v);render()},
  award(){const cur=G().play.current;if(cur)send('play.award',{grades:S.grade[cur.key]||{}})},
  cancelq(){send('play.cancel')},
  next(){send('play.next')},
  timeadd(){send('timer.add',{sec:10})},
  timestop(){if(confirm('Хариулах хугацааг одоо дуусгах уу?'))send('timer.stop')},
  forceend(){if(confirm('Тоглоомыг одоо дуусгаж байрлалыг гаргах уу?'))send('game.end')},
  async sendans(b){
    const role=currentRole(),key=b.dataset.key,text=(S.form['ans:'+key+':'+role]||'').trim();
    if(!text)return toast('Хариултаа бичнэ үү.');
    clearTimeout(ansTimer);
    if((await send('play.answer',Object.assign({key,text},asParam()))).ok)toast('Хариулт илгээгдлээ ✓');
  },
  tbstart(){send('tb.start',{q:S.form.tbq||'',a:S.form.tba||''}).then(r=>{if(r.ok){S.form.tbq='';S.form.tba=''}})},
  tbjudge(){const tb=G().tiebreak;if(tb)send('tb.judge',{grades:S.grade[tb.key]||{}})},
  tbfinish(){send('tb.finish')},
  newgame(){if(confirm('Одоогийн тоглолтыг дуусгаж бэлтгэл рүү буцах уу? Асуулт, оролцогчид хадгалагдана. Ахлагч нарын код хүчингүй болно.')){S.grade={};S.viewAs='admin';send('game.reset')}}
};
// Бичсэн хариултыг автоматаар хадгалах (хугацаа дуусахаас өмнө алдагдахгүй)
function autoSave(key){
  clearTimeout(ansTimer);
  ansTimer=setTimeout(()=>{
    const role=currentRole(),text=(S.form['ans:'+key+':'+role]||'').trim();
    const cur=activeQ();if(!text||!cur||cur.key!==key||qState(cur)!=='running')return;
    send('play.answer',Object.assign({key,text},asParam()),true);
  },500);
}
function syncAwardBtn(){
  const st=G();if(!st)return;const cur=st.phase==='play'?st.play.current:st.tiebreak;if(!cur)return;
  const elig=st.phase==='play'?eligible(st,cur.capId):cur.group,g=S.grade[cur.key]||{};
  const b=document.querySelector('[data-act="award"],[data-act="tbjudge"]');if(b)b.disabled=!elig.every(id=>g[id]!=null);
}

document.addEventListener('click',e=>{
  sfx.unlock();
  const b=e.target.closest('[data-act]');if(!b||b.disabled)return;
  const fn=actions[b.dataset.act];if(fn){e.preventDefault();fn(b,e)}
});
document.addEventListener('input',e=>{
  const t=e.target;
  if(t.dataset&&t.dataset.bind)S.form[t.dataset.bind]=t.value;
  if(t.dataset&&t.dataset.anskey)autoSave(t.dataset.anskey);
  if(t.dataset&&t.dataset.gradeKey){const k=t.dataset.gradeKey;S.grade[k]=S.grade[k]||{};if(t.value==='')delete S.grade[k][t.dataset.gradeCap];else S.grade[k][t.dataset.gradeCap]=Number(t.value);syncAwardBtn()}
});
document.addEventListener('change',e=>{
  const t=e.target;
  if(t.id==='role-sel'){S.viewAs=t.value;render();return}
  if(t.id==='f-rounds'){S.setup.rounds=Math.max(1,parseInt(t.value,10)||1);pushSetup();render();return}
  if(t.id==='f-time'){S.setup.timeLimit=Math.min(600,Math.max(5,parseInt(t.value,10)||30));pushSetup();render();return}
  if(t.name==='amode'){S.setup.answerMode=t.value;pushSetup();render();return}
});
document.addEventListener('keydown',e=>{
  if(e.key!=='Enter')return;const t=e.target;
  if(t.id==='f-code'){e.preventDefault();actions.login()}
  else if(t.id&&t.id.startsWith('ans-')&&!e.shiftKey){e.preventDefault();const b=document.querySelector(`[data-act="sendans"][data-key="${t.id.slice(4)}"]`);if(b)actions.sendans(b)}
});
render();
})();
