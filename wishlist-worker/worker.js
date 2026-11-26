// Fort Grozny community car wishlist (separate Cloudflare Worker).
// Required D1 binding: WISHLIST_DB. Required secrets: TURNSTILE_SECRET_KEY, WISHLIST_VOTER_SALT.
// No payment credentials, FG-ID or raw IP addresses are collected or stored.
const ALLOWED_ORIGINS = new Set(['https://playfortgrozny.ru', 'https://www.playfortgrozny.ru']);
const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const encoder = new TextEncoder();

function reply(data, status = 200, origin = '') {
  const headers = new Headers(jsonHeaders);
  if (ALLOWED_ORIGINS.has(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Vary', 'Origin');
  }
  return new Response(JSON.stringify(data), {status, headers});
}
function corsPreflight(origin) {
  if (!ALLOWED_ORIGINS.has(origin)) return new Response(null, {status:403});
  return new Response(null, {status:204, headers:{
    'Access-Control-Allow-Origin':origin,
    'Access-Control-Allow-Methods':'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers':'Content-Type, Authorization',
    'Access-Control-Max-Age':'600',
    'Vary':'Origin'
  }});
}
function prohibited(input) {
  const map={'x':'х','y':'у','u':'у','p':'р','c':'с','o':'о','a':'а','e':'е','k':'к','b':'в','m':'м','t':'т','h':'н','0':'о','3':'з','4':'ч','6':'б'};
  const normalized=input.normalize('NFKC').toLowerCase().replace(/ё/g,'е');
  const compact=normalized.replace(/[^а-яa-z0-9]/g,'').replace(/[a-z0346]/g,c=>map[c]||c);
  return /ху[йиеяю]|пизд|пид[аоеи]р|пед[аоеи]р|ебан|ебат|ебуч|бля[дт]|сука|мудак|залуп|манда|говно|шлюх|долбоеб/.test(compact) || /(?:fuck|shit|bitch|faggot|cunt|pidar|pizda|huy|khuy|blyat|suka|mudak)/i.test(normalized.replace(/[^a-z]/g,''));
}

function validateName(input) {
  if (typeof input !== 'string') return null;
  const name=input.normalize('NFKC').replace(/\s+/g,' ').trim();
  if (name.length < 3 || name.length > 64 || !/[\p{L}]/u.test(name)) return null;
  if (!/^[\p{L}\p{N} .+()\/-]+$/u.test(name)) return null;
  if (/https?|www|telegram|t\.me|discord|\.com|\.ru/i.test(name)) return null;
  if (/(.)\1{7}/u.test(name)) return null;
  const canonical=name.toLocaleLowerCase('ru-RU').replace(/[.+()\/-]/g,' ').replace(/\s+/g,' ').trim();
  if (canonical.length < 3) return null;
  return {name, canonical};
}
async function identity(request, salt) {
  // Pseudonymous identifier used only for anti-abuse; no raw IP or UA kept in D1.
  const ip=request.headers.get('CF-Connecting-IP')||'unknown';
  const ua=(request.headers.get('User-Agent')||'').slice(0,180);
  const key=await crypto.subtle.importKey('raw', encoder.encode(salt), {name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signature=await crypto.subtle.sign('HMAC',key,encoder.encode(ip+'|'+ua));
  return Array.from(new Uint8Array(signature),b=>b.toString(16).padStart(2,'0')).join('');
}
async function verifiedTurnstile(token,request,secret) {
  if (!secret || typeof token !== 'string' || token.length < 10 || token.length > 2048) return false;
  const body=new FormData();
  body.set('secret',secret);
  body.set('response',token);
  const ip=request.headers.get('CF-Connecting-IP');
  if(ip) body.set('remoteip',ip);
  try {
    const resp=await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',{
      method:'POST',body,signal:AbortSignal.timeout(8000)
    });
    if(!resp.ok)return false;
    const data=await resp.json();
    // A valid token must originate from our site's hostname (never arbitrary domains).
    return data.success===true && (data.hostname==='playfortgrozny.ru'||data.hostname==='www.playfortgrozny.ru');
  } catch {return false;}
}
async function parseBody(request) {
  const size=Number(request.headers.get('Content-Length')||'0');
  if(size > 3500)return null;
  if(!(request.headers.get('Content-Type')||'').toLowerCase().includes('application/json'))return null;
  try {
    const raw=await request.text();
    if(raw.length > 3500)return null;
    const data=JSON.parse(raw);
    return data && typeof data==='object' && !Array.isArray(data)?data:null;
  } catch {return null;}
}
async function listing(db) {
  const rows=await db.prepare(`
    SELECT c.id, c.name, c.created_at AS createdAt, COUNT(v.car_id) AS votes
    FROM wishlist_cars c LEFT JOIN wishlist_votes v ON v.car_id=c.id
    WHERE c.status='approved'
    GROUP BY c.id
    ORDER BY votes DESC, c.created_at DESC, c.id DESC
    LIMIT 100
  `).all();
  return (rows.results||[]).map(r=>({
    id:r.id,name:r.name,votes:Number(r.votes)||0,createdAt:r.createdAt
  }));
}
async function currentCar(db,id) {
  return db.prepare(`
    SELECT c.id,c.name,COUNT(v.car_id) AS votes
    FROM wishlist_cars c LEFT JOIN wishlist_votes v ON v.car_id=c.id
    WHERE c.id=? AND c.status='approved' GROUP BY c.id
  `).bind(id).first();
}
async function processRequest(request,env,origin,url) {
  if(!env.WISHLIST_DB)return reply({error:'База предложений не подключена'},503,origin);
  const path=url.pathname.replace(/\/+$/,'')||'/';
  if(path.startsWith('/api/admin/')) {
    if(!ALLOWED_ORIGINS.has(origin))return reply({error:'Недопустимый источник'},403,origin);
    const secret=env.WISHLIST_ADMIN_TOKEN;
    const provided=request.headers.get('Authorization')||'';
    if(!secret || secret.length<32 || provided.length>512)return reply({error:'Доступ запрещён'},403,origin);
    const expected=encoder.encode('Bearer '+secret);
    const actual=encoder.encode(provided);
    const [x,y]=await Promise.all([crypto.subtle.digest('SHA-256',expected),crypto.subtle.digest('SHA-256',actual)]);
    const aa=new Uint8Array(x),bb=new Uint8Array(y);
    let diff=0;for(let i=0;i<aa.length;i++)diff|=aa[i]^bb[i];
    if(diff!==0)return reply({error:'Доступ запрещён'},403,origin);
    if(request.method==='GET' && path==='/api/admin/wishlist'){
      const rows=await env.WISHLIST_DB.prepare("SELECT c.id,c.name,c.status,c.created_at AS createdAt,COUNT(v.car_id) AS votes FROM wishlist_cars c LEFT JOIN wishlist_votes v ON v.car_id=c.id GROUP BY c.id ORDER BY c.id DESC LIMIT 500").all();
      return reply({cars:rows.results||[]},200,origin);
    }
    const match=path.match(/^\/api\/admin\/wishlist\/(\d+)\/hide$/);
    if(request.method==='POST' && match){
      const id=Number(match[1]);
      if(!Number.isSafeInteger(id)||id<1)return reply({error:'Неверный ID'},400,origin);
      const result=await env.WISHLIST_DB.prepare("UPDATE wishlist_cars SET status='hidden' WHERE id=?").bind(id).run();
      return reply({ok:true,changed:result.meta?.changes||0},200,origin);
    }
    return reply({error:'Маршрут не найден'},404,origin);
  }
  if(request.method==='GET' && path==='/api/wishlist') {
    const cars=await listing(env.WISHLIST_DB);
    return reply({cars,accepting:!!(env.TURNSTILE_SECRET_KEY&&env.WISHLIST_VOTER_SALT)},200,origin);
  }
  if(request.method==='GET' && path==='/api/health') {
    return reply({ok:true,accepting:!!(env.TURNSTILE_SECRET_KEY&&env.WISHLIST_VOTER_SALT)},200,origin);
  }
  if(request.method!=='POST')return reply({error:'Маршрут не найден'},404,origin);
  // An Origin check is NOT authentication, but rejects unsolicited browser forms.
  // Anti-abuse protection is implemented by server-validated, single-use Turnstile.
  if(!ALLOWED_ORIGINS.has(origin))return reply({error:'Запрос с недопустимого сайта'},403,origin);
  if(!env.TURNSTILE_SECRET_KEY || !env.WISHLIST_VOTER_SALT)
    return reply({error:'Приём предложений ещё не активирован'},503,origin);
  const body=await parseBody(request);
  if(!body)return reply({error:'Некорректные данные'},400,origin);
  if(!await verifiedTurnstile(body.token,request,env.TURNSTILE_SECRET_KEY))
    return reply({error:'Проверка безопасности не пройдена. Попробуйте ещё раз.'},403,origin);
  const voter=await identity(request,env.WISHLIST_VOTER_SALT);
  if(path==='/api/wishlist'){
    if(typeof body.name==='string' && prohibited(body.name))return reply({error:'Недопустимое название. Укажите марку и модель автомобиля без оскорблений.'},400,origin);
    const candidate=validateName(body.name);
    if(!candidate)return reply({error:'Укажите марку и модель: от 3 до 64 символов, без ссылок.'},400,origin);
    const db=env.WISHLIST_DB;
    let car=await db.prepare('SELECT id,status FROM wishlist_cars WHERE canonical_name=?')
      .bind(candidate.canonical).first();
    if(car && car.status!=='approved')return reply({error:'Это предложение скрыто модерацией'},409,origin);
    if(!car){
      const recent=await db.prepare(`
        SELECT COUNT(*) AS n FROM wishlist_cars WHERE author_key=?
        AND created_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')
      `).bind(voter).first();
      if(Number(recent?.n||0)>=3)return reply({error:'Не более трёх новых моделей за сутки.'},429,origin);
      await db.prepare('INSERT OR IGNORE INTO wishlist_cars(name,canonical_name,author_key) VALUES (?,?,?)')
        .bind(candidate.name,candidate.canonical,voter).run();
      car=await db.prepare('SELECT id,status FROM wishlist_cars WHERE canonical_name=?')
        .bind(candidate.canonical).first();
    }
    if(!car||car.status!=='approved')return reply({error:'Не удалось обработать предложение'},503,origin);
    await db.prepare('INSERT OR IGNORE INTO wishlist_votes(car_id,voter_key) VALUES (?,?)')
      .bind(car.id,voter).run();
    const item=await currentCar(db,car.id);
    return reply({ok:true,car:item,message:'Автомобиль добавлен в общий список. Голос учтён.'},200,origin);
  }
  const voteMatch=path.match(/^\/api\/wishlist\/(\d+)\/vote$/);
  if(voteMatch){
    const id=Number(voteMatch[1]);
    if(!Number.isSafeInteger(id)||id<1)return reply({error:'Некорректный номер'},400,origin);
    const db=env.WISHLIST_DB;
    const car=await currentCar(db,id);
    if(!car)return reply({error:'Автомобиль не найден'},404,origin);
    const existing=await db.prepare('SELECT 1 AS found FROM wishlist_votes WHERE car_id=? AND voter_key=?')
      .bind(id,voter).first();
    if(existing)return reply({ok:true,alreadyVoted:true,car},200,origin);
    const recent=await db.prepare(`
      SELECT COUNT(*) AS n FROM wishlist_votes WHERE voter_key=?
      AND created_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')
    `).bind(voter).first();
    if(Number(recent?.n||0)>=30)return reply({error:'Лимит голосов за сутки исчерпан'},429,origin);
    await db.prepare('INSERT OR IGNORE INTO wishlist_votes(car_id,voter_key) VALUES (?,?)').bind(id,voter).run();
    return reply({ok:true,alreadyVoted:false,car:await currentCar(db,id)},200,origin);
  }
  return reply({error:'Маршрут не найден'},404,origin);
}

export default {
  async fetch(request,env){
    const origin=request.headers.get('Origin')||'';
    if(request.method==='OPTIONS')return corsPreflight(origin);
    let url;
    try {url=new URL(request.url);}catch{return reply({error:'Неверный адрес'},400,origin);}
    try{return await processRequest(request,env,origin,url);}
    catch(error){
      console.error('Wishlist API error',error?.name||'UnknownError');
      return reply({error:'Временная ошибка сервера. Повторите позже.'},503,origin);
    }
  }
};
