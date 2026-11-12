import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
const source=process.env.DATABASE_PATH||'./data/bot.sqlite';
if(!existsSync(source)) {console.error('아직 DB가 없어요. 봇을 실행하고 보스방을 만든 뒤 백업하세요.');process.exit(1);}
const target=resolve(process.argv[2]||`./data/backups/bot-${new Date().toISOString().replace(/[:.]/g,'-')}.sqlite`);
if(existsSync(target)) {console.error('이미 있는 백업 파일에는 덮어쓰지 않아요. 다른 경로를 지정하세요.');process.exit(1);}
mkdirSync(dirname(target),{recursive:true,mode:0o700});
const db=new DatabaseSync(source);
try {await backup(db,target);console.log(`백업 완료: ${target}`);}finally {db.close();}
