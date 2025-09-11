import { VK } from "vk-io";
import fs from "fs/promises";
import express from "express";
import fetch from "node-fetch";

// ====================
// ====== Настройки ======
// ====================
const TASKS_FILE = "./tasks.json";    // Файл задач
const USERS_FILE = "./users.json";    // Файл пользователей (варны, баны)
const LOG_FILE = "./logs.txt";        // Лог сообщений
const GROUP_FILE = "./group.json";    // Привязанная группа
const TIMEZONE_OFFSET = 3;            // Часовой пояс (МСК)
const PORT = process.env.PORT || 8080; // Порт Express сервера

// ====================
// ====== Express ======
// ====================
const app = express();
app.use(express.json());

// Keep-alive ping
app.get("/ping", (req, res) => res.send("pong"));

// Веб-страница со списком задач
app.get("/", async (req, res) => {
  try {
    const data = await fs.readFile(TASKS_FILE, "utf-8");
    const tasks = JSON.parse(data);
    let html = `
    <html>
    <head>
      <meta charset="utf-8">
      <title>Задачи бота</title>
      <style>
        body { font-family: sans-serif; background:#f9f9f9; padding:20px;}
        table { border-collapse: collapse; width:100%; background:#fff;}
        th, td { border:1px solid #ccc; padding:8px; text-align:left;}
        th { background:#f4f4f4;}
        tr:nth-child(even){background:#fdfdfd;}
        tr:hover{background:#f1f7ff;}
        .sent{color:green;font-weight:bold;}
        .not-sent{color:red;font-weight:bold;}
      </style>
      <script>setTimeout(()=>{location.reload();},5000);</script>
    </head>
    <body>
      <h1>Список задач</h1>
      <table>
        <tr><th>#</th><th>Время</th><th>Текст</th><th>Повторов</th><th>Отправлено</th><th>Кто создал</th></tr>
    `;
    tasks.forEach((t,i)=>{
      html+=`<tr>
      <td>${i+1}</td>
      <td>${t.time}</td>
      <td>${t.text.replace(/\[id\d+\|([^\]]+)\]/g,"$1")}</td>
      <td>${t.times}</td>
      <td class="${t.sent?"sent":"not-sent"}">${t.sent?"✅":"❌"}</td>
      <td>${t.peerId}</td>
      </tr>`;
    });
    html+="</table></body></html>";
    res.send(html);
  } catch(err){ res.send("Ошибка загрузки задач: "+err.message); }
});

// Запуск сервера
app.listen(PORT, ()=>console.log(`✅ Server running on port ${PORT}`));

// Self-ping каждые 4 минуты
setInterval(()=>fetch(`http://localhost:${PORT}/ping`).catch(()=>{}),4*60*1000);

// ====================
// ====== Утилиты ======
// ====================
function formatTime(date=new Date()){
  const local = new Date(date.getTime() + TIMEZONE_OFFSET*60*60*1000);
  return `${String(local.getUTCHours()).padStart(2,"0")}:${String(local.getUTCMinutes()).padStart(2,"0")}`;
}

function validateTimeString(time){
  const parts = time.split(":");
  if(parts.length!==2) return false;
  const [h,m] = parts.map(x=>parseInt(x,10));
  return !isNaN(h) && !isNaN(m) && h>=0 && h<=23 && m>=0 && m<=59;
}

function createTask(peerId,time,text,times){ 
  return {peerId,time,text,times,sent:false,createdAt:new Date().toISOString()};
}

// ====================
// ====== Файлы ======
// ====================
async function loadJSON(file){ try{return JSON.parse(await fs.readFile(file,"utf-8"))}catch{return null;} }
async function saveJSON(file,data){ await fs.writeFile(file,JSON.stringify(data,null,2),"utf-8"); }

// ====================
// ====== Глобальные переменные ======
// ====================
let tasks = [];              // Задачи
let users = {};              // Варны и баны
let isStarted = false;       // Флаг активации
let groupPeerId = null;      // Привязанная группа
let saperGames = {};         // Состояния сапёра

// Загрузка данных при старте
(async()=>{
  tasks = await loadJSON(TASKS_FILE) || [];
  users = await loadJSON(USERS_FILE) || {};
  const g = await loadJSON(GROUP_FILE);
  if(g?.groupPeerId){ isStarted=true; groupPeerId=g.groupPeerId; }
  console.log(`✅ Загружено задач: ${tasks.length}`);
})();

// ====================
// ====== VK API ======
// ====================
const vk = new VK({ token: "vk1.a.F3Zjpr-ACP9y4IGgB718zAUCTQUci4jeRkw04gctIKdOSD_406C7BJh7w1qzKGT6junxgDnni3yg2prsgXr_ANuVnWwOwNikTg3fEyRLYnFt-85i62uEw8mWxLLOfQpyOH3x5hmW8imKVIeWl1cJWOGW7LmlsJoSXQRJuMKLUsh8kQObgJc1asHNhrtscv7w3s53UzCk0PWr19jz2j42yQ", apiVersion:"5.199" });
const { updates } = vk;

// ====================
// ====== Логирование ======
// ====================
async function logMessage(context){
  const line = `[${formatTime()}] ID:${context.senderId} Peer:${context.peerId} Text:"${context.text}"\n`;
  await fs.appendFile(LOG_FILE,line);
}

// ====================
// ====== Варны/Баны ======
// ====================
function checkBan(id){ return users[id]?.bannedUntil && Date.now()<users[id].bannedUntil; }

function addWarn(id){
  if(!users[id]) users[id]={warns:0,bannedUntil:null};
  users[id].warns += 1;
  if(users[id].warns>=3){
    users[id].bannedUntil = Date.now()+60*60*1000; // 1 час бан
    users[id].warns = 0;
    return "⚠️ Пользователь забанен на 1 час";
  }
  return `⚠️ Предупреждение №${users[id].warns}`;
}

// ====================
// ====== Кик пользователя ======
async function kickUserInChat(peerId,userId){
  if(peerId<2000000000) return "❌ Это не чат, кик невозможен";
  const chatId = peerId - 2000000000;
  try{
    await vk.api.messages.removeChatUser({chat_id:chatId, member_id:userId});
    return "👢 Пользователь кикнут";
  }catch(err){ return "❌ Не удалось кикнуть: "+err.message; }
}

// ====================
// ====== Сапёр ======
function generateSaperBoard(size=6,mines=8){
  const board=Array(size).fill(0).map(()=>Array(size).fill(0));
  let placed=0;
  while(placed<mines){
    const x=Math.floor(Math.random()*size);
    const y=Math.floor(Math.random()*size);
    if(board[x][y]===0){ board[x][y]="💣"; placed++; }
  }
  return board;
}

function renderSaperButtons(board){
  return board.map((row,x)=>row.map((cell,y)=>{
    return { text:"⬜", payload:`saper_${x}_${y}`, color:"secondary" };
  }));
}

// ====================
// ====== Отправка сообщений ======
async function sendMessage(peerId,text,keyboard=null){
  try{
    await vk.api.messages.send({peer_id:peerId,message:text,random_id:Math.floor(Math.random()*1e9),keyboard});
  }catch(err){ console.error(`❌ Ошибка отправки: ${err.message}`); }
}

// ====================
// ====== Планировщик задач ======
setInterval(async()=>{
  const cur=formatTime(); let changed=false;
  for(let i=tasks.length-1;i>=0;i--){
    const t=tasks[i];
    if(validateTimeString(t.time) && t.time===cur && !t.sent){
      for(let j=0;j<t.times;j++) await sendMessage(t.peerId,t.text);
      t.sent = true; tasks.splice(i,1); changed=true;
    }
  }
  if(changed) await saveJSON(TASKS_FILE,tasks);
},5000);

// ====================
// ====== Обработка сообщений ======
updates.on("message_new", async(context)=>{
  const peerId=context.peerId;
  const text=context.text?.trim();
  const senderId=context.senderId;
  if(!text) return;

  await logMessage(context);

  // Пока бот не активирован, ждём /начать
  if(!isStarted){
    if(text==="/начать"){
      isStarted=true;
      groupPeerId=peerId;
      await saveJSON(GROUP_FILE,{groupPeerId});
      return context.send("✅ Бот активирован для этой группы");
    }
    return;
  }

  if(peerId!==groupPeerId) return;  // Игнорируем другие чаты
  if(checkBan(senderId)) return;

  // ========= Команды =========
  if(text.startsWith("!bind")){
    if(context.isChat){
      const members = await vk.api.messages.getConversationMembers({peer_id:peerId});
      const member = members.items.find(m=>m.member_id===senderId);
      if(!member?.is_admin) return context.send("❌ Только админы могут !bind");
    }
    const parts=text.split(" ");
    if(parts.length<3) return context.send("❌ Использование: !bind HH:MM текст [повторы]");
    let time=parts[1];
    if(!validateTimeString(time)) return context.send("❌ Неверный формат");
    let repeatCount=1;
    let msgText="";
    if(!isNaN(parts[parts.length-1])){ repeatCount=parseInt(parts[parts.length-1]); msgText=parts.slice(2,-1).join(" "); } 
    else msgText=parts.slice(2).join(" ");
    if(!msgText) return context.send("❌ Текст задачи пуст");
    tasks.push(createTask(peerId,time,msgText,repeatCount));
    await saveJSON(TASKS_FILE,tasks);
    return context.send(`✅ Задача добавлена:\n🕒 ${time}\n💬 "${msgText}"\n🔁 ${repeatCount} раз`);
  }

  if(text==="!tasks"){ 
    if(tasks.length===0) return context.send("📭 Нет задач"); 
    let list="📋 Активные задачи:\n"; tasks.forEach((t,i)=>{ list+=`${i+1}. [${t.time}] "${t.text}" ×${t.times}\n`; }); 
    return context.send(list); 
  }

  if(text.startsWith("!deltask")){
    const idx=parseInt(text.split(" ")[1])-1; if(isNaN(idx)||idx<0||idx>=tasks.length) return context.send("❌ Неверный номер");
    const removed=tasks.splice(idx,1); await saveJSON(TASKS_FILE,tasks); return context.send(`🗑 Удалена задача: "${removed[0].text}"`);
  }

  if(text.startsWith("!warn")){
    const target=parseInt(text.split(" ")[1]); if(!target) return context.send("❌ Использование: !warn ID");
    const msg=addWarn(target); await saveJSON(USERS_FILE,users); return context.send(msg);
  }

  if(text.startsWith("!kick")){
    const target=parseInt(text.split(" ")[1]); if(!target) return context.send("❌ Использование: !kick ID");
    const msg=await kickUserInChat(peerId,target); return context.send(msg);
  }

  if(text==="!saper"){
    const board = generateSaperBoard();
    saperGames[senderId] = board;
    const keyboard = { buttons: renderSaperButtons(board) };
    return context.send("🕹 Сапёр! Нажимай на плитки:",keyboard);
  }

  // ========= Кнопки Сапёра =========
  let payloadStr = null;
  if(context.payload){
    if(typeof context.payload==="string") payloadStr = context.payload;
    else if(typeof context.payload==="object" && context.payload.payload) payloadStr = context.payload.payload;
  }

  if(payloadStr?.startsWith("saper_")){
    const parts = payloadStr.split("_");
    const x = parseInt(parts[1]);
    const y = parseInt(parts[2]);
    const board = saperGames[senderId];
    if(!board) return context.send("❌ Игра не найдена. Напиши !saper");
    if(board[x][y]==="💣"){ delete saperGames[senderId]; return context.send("💥 Бум! Вы проиграли!"); }
    board[x][y]="✅"; // открытая клетка
    const keyboard = { buttons: renderSaperButtons(board) };
    return context.send("🟩 Открыто!",keyboard);
  }

  if(text==="!help"){
    return context.send(`
📜 Команды:
/начать - активировать бота
!bind HH:MM текст [повторы] - добавить задачу
!tasks - список задач
!deltask N - удалить задачу
!warn ID - варн
!kick ID - кик
!saper - интерактивный сапёр
!help - помощь
`);
  }
});

// ====================
// ====== Запуск ======
(async()=>{ console.log("🚀 Бот запущен"); await updates.start(); })();
