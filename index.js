import { VK } from "vk-io";
import fs from "fs/promises";
import express from "express";
import fetch from "node-fetch";

// === Константы ===
const TASKS_FILE = "./tasks.json";
const USERS_FILE = "./users.json";
const LOG_FILE = "./logs.txt";
const TIMEZONE_OFFSET = 3; // Москва UTC+3
const PORT = process.env.PORT || 3000;

// === Express Keep-alive ===
const app = express();
app.use(express.json());

// /ping для self-ping
app.get("/ping", (req, res) => res.send("pong"));

// HTML страница задач
app.get("/", async (req, res) => {
  try {
    const tasksData = await fs.readFile(TASKS_FILE, "utf-8");
    const tasks = JSON.parse(tasksData);

    let html = `
    <html>
      <head><title>Задачи бота</title><meta charset="utf-8">
      <style>
      body { font-family: sans-serif; padding: 20px; background: #f9f9f9; }
      h1 { color: #333; }
      table { border-collapse: collapse; width: 100%; background: #fff; }
      th, td { border: 1px solid #ccc; padding: 8px; text-align: left; }
      th { background-color: #f4f4f4; }
      tr:nth-child(even){background:#fdfdfd;}
      tr:hover{background:#f1f7ff;}
      .sent{color:green;font-weight:bold;}
      .not-sent{color:red;font-weight:bold;}
      </style>
      <script>setTimeout(()=>{location.reload();},5000);</script>
      </head>
      <body>
        <h1>Список задач бота</h1>
        <table>
        <tr><th>#</th><th>Время</th><th>Текст</th><th>Повторов</th><th>Отправлено</th><th>Кто создал</th></tr>
    `;

    tasks.forEach((task,i)=>{
      html+=`<tr>
      <td>${i+1}</td>
      <td>${task.time}</td>
      <td>${task.text.replace(/\[id\d+\|([^\]]+)\]/g,"$1")}</td>
      <td>${task.times}</td>
      <td class="${task.sent?"sent":"not-sent"}">${task.sent?"✅":"❌"}</td>
      <td>${task.peerId}</td>
      </tr>`;
    });

    html += "</table></body></html>";
    res.send(html);
  } catch(err){ res.send("Ошибка загрузки задач: "+err.message); }
});

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

// self-ping каждые 4 минуты
setInterval(() => {
  fetch(`http://localhost:${PORT}/ping`).then(()=>console.log("🔄 Self-ping OK")).catch(()=>console.error("❌ Self-ping failed"));
}, 4*60*1000);

// === Утилиты ===
function formatTime(date=new Date()){
  const local = new Date(date.getTime() + TIMEZONE_OFFSET*60*60*1000);
  return `${String(local.getUTCHours()).padStart(2,"0")}:${String(local.getUTCMinutes()).padStart(2,"0")}`;
}

function validateTimeString(time){
  const parts = time.split(":");
  if(parts.length!==2) return false;
  const [h,m] = parts.map(x=>parseInt(x,10));
  return !isNaN(h)&&!isNaN(m)&&h>=0&&m<=59;
}

function createTask(peerId,time,text,times){ return {peerId,time,text,times,sent:false,createdAt:new Date().toISOString()}; }

// === Файлы ===
async function loadTasks(){ try{return JSON.parse(await fs.readFile(TASKS_FILE,"utf-8"))}catch{return [];} }
async function saveTasks(){ await fs.writeFile(TASKS_FILE,JSON.stringify(tasks,null,2),"utf-8"); }
async function loadUsers(){ try{return JSON.parse(await fs.readFile(USERS_FILE,"utf-8"))}catch{return {};} }
async function saveUsers(){ await fs.writeFile(USERS_FILE,JSON.stringify(users,null,2),"utf-8"); }

// === Глобальные переменные ===
let tasks = [];
let users = {}; // {userId:{warns:0,bannedUntil:null}}

(async()=>{ tasks = await loadTasks(); users = await loadUsers(); console.log(`✅ Загружено задач: ${tasks.length}`); })();

// === VK API ===
const vk = new VK({ token: process.env.VK_TOKEN, apiVersion:"5.199" });
const { updates } = vk;

// === Логирование сообщений ===
async function logMessage(context){
  const time = formatTime();
  const line = `[${time}] ID:${context.senderId} Text:"${context.text}"\n`;
  await fs.appendFile(LOG_FILE,line);
}

// === Варны и бан ===
function checkBan(id){ const u=users[id]; return u?.bannedUntil && Date.now()<u.bannedUntil; }
function addWarn(id){
  if(!users[id]) users[id]={warns:0,bannedUntil:null};
  users[id].warns+=1;
  if(users[id].warns>=3){ users[id].bannedUntil=Date.now()+60*60*1000; users[id].warns=0; return "⚠️ Пользователь забанен на 1 час"; }
  return `⚠️ Предупреждение №${users[id].warns}`;
}

// === Кик (мгновенный) ===
function kickUser(id){ users[id]={warns:0,bannedUntil:Date.now()}; return "👢 Пользователь кикнут"; }

// === Сапёр ===
function generateSaperBoard(size=6,mines=8){
  const board=Array(size).fill(0).map(()=>Array(size).fill(0));
  let placed=0;
  while(placed<mines){
    const x=Math.floor(Math.random()*size);
    const y=Math.floor(Math.random()*size);
    if(board[x][y]===0){board[x][y]="💣";placed++;}
  }
  return board;
}
function renderSaper(board){ return board.map(r=>r.map(c=>c==="💣"?c:"⬜").join(" ")).join("\n"); }

// === Отправка сообщений ===
async function sendMessage(peerId,text){
  try{ await vk.api.messages.send({peer_id:peerId,message:text,random_id:Math.floor(Math.random()*1e9)}); } 
  catch(err){ console.error(`❌ Ошибка отправки peer_id=${peerId}: ${err.message}`); }
}

// === Планировщик задач ===
setInterval(async()=>{
  const cur=formatTime(); let changed=false;
  for(let i=tasks.length-1;i>=0;i--){
    const t=tasks[i];
    if(validateTimeString(t.time)&&t.time===cur&&!t.sent){
      for(let j=0;j<t.times;j++) await sendMessage(t.peerId,t.text);
      t.sent=true; tasks.splice(i,1); changed=true;
    }
  }
  if(changed) await saveTasks();
},5000);

// === Обработка сообщений ===
updates.on("message_new", async(context)=>{
  if(!context.text) return;
  const text=context.text.trim();
  await logMessage(context);
  const peerId=context.peerId;
  const senderId=context.senderId;

  if(checkBan(senderId)) return;

  // === Команды системы задач ===
  if(text.startsWith("!bind")||text==="!tasks"||text.startsWith("!deltask")){
    if(text.startsWith("!bind")){
      if(context.isChat){
        const members = await vk.api.messages.getConversationMembers({peer_id});
        const member = members.items.find(m=>m.member_id===senderId);
        if(!member?.is_admin) return context.send("❌ Только админы могут использовать !bind");
      }
      const parts=text.split(" ");
      if(parts.length<3) return context.send("❌ Использование: !bind HH:MM текст [кол-во повторов]");
      let time=parts[1];
      if(!validateTimeString(time)) return context.send("❌ Неверный формат времени");
      let repeatCount=1; let msgText="";
      if(!isNaN(parts[parts.length-1])){ repeatCount=parseInt(parts[parts.length-1]); msgText=parts.slice(2,-1).join(" "); }
      else msgText=parts.slice(2).join(" ");
      if(!msgText) return context.send("❌ Текст задачи не может быть пустым");
      if(repeatCount<1) return context.send("❌ Кол-во повторов >0");
      const newTask=createTask(peerId,time,msgText,repeatCount);
      tasks.push(newTask); await saveTasks();
      return context.send(`✅ Задача добавлена:\n🕒 ${time}\n💬 "${msgText}"\n🔁 ${repeatCount} раз`);
    }
    if(text==="!tasks"){
      if(tasks.length===0) return context.send("📭 Нет задач");
      let list="📋 Активные задачи:\n";
      tasks.forEach((t,i)=>{ list+=`${i+1}. [${t.time}] "${t.text}" ×${t.times}\n`; });
      return context.send(list);
    }
    if(text.startsWith("!deltask")){
      const parts=text.split(" "); if(parts.length!==2) return context.send("❌ Использование: !deltask номер");
      const idx=parseInt(parts[1])-1; if(isNaN(idx)||idx<0||idx>=tasks.length) return context.send("❌ Неверный номер");
      const removed=tasks.splice(idx,1); await saveTasks();
      return context.send(`🗑 Удалена задача: "${removed[0].text}"`);
    }
  }

  // === Варны, кик, сапёр, помощь ===
  if(text.startsWith("!warn")){
    const target=parseInt(text.split(" ")[1]); if(!target) return context.send("❌ Использование: !warn ID");
    const msg=addWarn(target); await saveUsers(); return context.send(msg);
  }

  if(text.startsWith("!kick")){
    const target=parseInt(text.split(" ")[1]); if(!target) return context.send("❌ Использование: !kick ID");
    const msg=kickUser(target); await saveUsers(); return context.send(msg);
  }

  if(text==="!saper"){
    const board=generateSaperBoard(6,8);
    const rendered=renderSaper(board);
    return context.send(`🕹 Игра Сапёр:\n${rendered}`);
  }

  if(text==="!help"){
    return context.send(`
📜 Команды бота:
!bind HH:MM текст [повторы] - создать задачу
!tasks - список задач
!deltask N - удалить задачу
!warn ID - выдать варн
!kick ID - мгновенный кик пользователя
!saper - сыграть в Сапёр
!help - показать команды
`);
  }

});

// === Запуск ===
(async()=>{ console.log("🚀 Бот запущен"); await updates.start(); })();
