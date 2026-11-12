import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { requireRule } from './errors.js';

// Aggregate store for a single-process bot. Swap this adapter when adding a web API.
export class Repository {
  constructor(path) {
    if(path!==':memory:') mkdirSync(dirname(resolve(path)),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    const version=this.db.prepare('PRAGMA user_version').get().user_version;
    requireRule(version<=1,'이 DB는 더 새로운 봇 버전에서 만들어졌어요.','DB_VERSION');
    this.db.exec(`CREATE TABLE IF NOT EXISTS workspaces (
      guild_id TEXT NOT NULL, thread_id TEXT NOT NULL, state_json TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(guild_id,thread_id)
    );
    CREATE TABLE IF NOT EXISTS receipts (
      request_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, thread_id TEXT NOT NULL,
      user_id TEXT NOT NULL, action TEXT NOT NULL, result_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    ); PRAGMA user_version=1;`);
  }
  read(ctx) {
    const row=this.db.prepare('SELECT state_json FROM workspaces WHERE guild_id=? AND thread_id=?').get(ctx.guildId,ctx.threadId);
    requireRule(row,'먼저 이 스레드에서 /보스방 시작을 실행해 주세요.','NOT_STARTED');
    return JSON.parse(row.state_json);
  }
  mutate(ctx,requestId,action,fn,{allowCreate=false}={}) {
    requireRule(ctx.guildId&&ctx.threadId&&ctx.userId,'스레드 참가자 정보가 필요해요.','FORBIDDEN');
    requireRule(typeof requestId==='string'&&requestId.length>0,'요청 식별자가 필요해요.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const receipt=this.db.prepare('SELECT * FROM receipts WHERE request_id=?').get(requestId);
      if(receipt) {
        requireRule(receipt.guild_id===ctx.guildId&&receipt.thread_id===ctx.threadId&&receipt.user_id===ctx.userId&&receipt.action===action,'다른 요청의 식별자를 사용할 수 없어요.','FORBIDDEN');
        this.db.exec('COMMIT'); return JSON.parse(receipt.result_json);
      }
      const row=this.db.prepare('SELECT state_json FROM workspaces WHERE guild_id=? AND thread_id=?').get(ctx.guildId,ctx.threadId);
      requireRule(row||allowCreate,'먼저 이 스레드에서 /보스방 시작을 실행해 주세요.','NOT_STARTED');
      const state=row?JSON.parse(row.state_json):{version:1,characters:[],parties:[],boardMessageId:null};
      const result=fn(state);
      this.db.prepare(`INSERT INTO workspaces(guild_id,thread_id,state_json) VALUES(?,?,?)
        ON CONFLICT(guild_id,thread_id) DO UPDATE SET state_json=excluded.state_json,revision=workspaces.revision+1`).run(ctx.guildId,ctx.threadId,JSON.stringify(state));
      this.db.prepare('INSERT INTO receipts(request_id,guild_id,thread_id,user_id,action,result_json) VALUES(?,?,?,?,?,?)').run(requestId,ctx.guildId,ctx.threadId,ctx.userId,action,JSON.stringify(result??null));
      this.db.exec('COMMIT'); return result;
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  pruneReceipts() { this.db.prepare("DELETE FROM receipts WHERE created_at < datetime('now','-7 days')").run(); }
  close() { this.db.close(); }
}
