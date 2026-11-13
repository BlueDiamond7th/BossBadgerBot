import { scheduleCard } from './schedule-views.js';
import { scheduleDate } from './schedule.js';
import { isParticipant } from './access.js';

export class ScheduleWorker {
  constructor({schedules,getChannel,guildId=null,canParticipate=isParticipant,onUpdate=async()=>{}}) {
    this.book=schedules;this.db=schedules.db;this.getChannel=getChannel;this.guildId=guildId;this.canParticipate=canParticipate;this.onUpdate=onUpdate;this.running=null;this.stopped=false;
    // A process may have died after Discord accepted a send. Do not blindly duplicate it.
    this.db.prepare("UPDATE schedule_jobs SET state='unknown',error='전송 중 봇이 재시작되어 결과를 확인할 수 없어요.' WHERE state='running'").run();
  }
  async start() {await this.tick();if(!this.stopped){this.timer=setInterval(()=>void this.tick().catch(()=>console.warn('[schedule] sweep-failed')),15_000);this.timer.unref();}}
  async stop() {this.stopped=true;clearInterval(this.timer);await this.running;}
  async tick() {
    if(this.stopped)return;
    if(this.running){await this.running;return;}
    this.running=(async()=>{for(const ctx of this.book.scopes()){if(this.guildId&&ctx.guildId!==this.guildId)continue;try{await this._scope(ctx);}catch(e){console.warn('[schedule]',e.code??e.name);}}})();
    try{await this.running;}finally{this.running=null;}
  }
  async refresh(ctx) {await this.tick();}
  obsolete(s,job) {
    return s.version!==job.version||(s.status==='elapsed'&&job.kind!=='cancelled')||
      (job.kind==='reminder'&&(s.status!=='confirmed'||s.startAt<=this.book.now()||this.book.now()-job.due_at>10*60_000))||
      (job.kind==='publish'&&['cancelled','elapsed'].includes(s.status));
  }
  async _scope(ctx) {
    this.book.maintenance(ctx);
    const dirty=this.db.prepare('SELECT id FROM schedules WHERE guild_id=? AND thread_id=? AND message_id IS NOT NULL AND rendered<revision').all(ctx.guildId,ctx.threadId);
    const jobs=this.db.prepare("SELECT j.* FROM schedule_jobs j JOIN schedules s ON s.id=j.schedule_id WHERE s.guild_id=? AND s.thread_id=? AND j.state='pending' AND j.due_at<=? ORDER BY j.due_at,j.rowid LIMIT 100").all(ctx.guildId,ctx.threadId,this.book.now());
    if(!dirty.length&&!jobs.length)return;
    let channel;
    try{channel=await this.getChannel(ctx.threadId);if(!channel||channel.archived||channel.locked||!channel.isTextBased?.())throw Object.assign(new Error('channel'),{code:'CHANNEL_UNAVAILABLE'});}
    catch(e){for(const j of jobs)this.db.prepare("UPDATE schedule_jobs SET state='failed',error=? WHERE id=? AND state='pending'").run('채널에 접근할 수 없어요. 채널 권한을 확인한 뒤 관리 메뉴에서 다시 게시해 주세요.',j.id);return;}
    for(const {id} of dirty) {
      const s=this.book.get(ctx,id);
      try{const message=await channel.messages.fetch(s.messageId);await message.edit(scheduleCard(s,this.book));this.book.markMessage(ctx,s.id,s.messageId,s.revision);}
      catch(e){if(e.code===10008)this.book.markMessage(ctx,s.id,null,s.revision);else console.warn('[schedule-card]',e.code??e.name);}
    }
    for(const job of jobs) {
      let s=this.book.get(ctx,job.schedule_id);
      if(this.obsolete(s,job)){this.db.prepare("UPDATE schedule_jobs SET state='obsolete' WHERE id=?").run(job.id);continue;}
      if(!this.db.prepare("UPDATE schedule_jobs SET state='running' WHERE id=? AND state='pending'").run(job.id).changes)continue;
      try {
        const data=JSON.parse(job.data_json),currentParty=this.book.partyService.snapshot(ctx).parties.find(p=>p.id===s.partyId),owner=currentParty?.creatorId??s.createdBy;
        let targets=s.members.map(m=>m.userId),text='';
        if(job.kind==='changed')targets=[...new Set([...targets,...(data.previousUsers??[])])];
        if(['pollClosed','dropout','conflict'].includes(job.kind))targets=[owner];
        if(job.kind==='reminder'){
          const snapshot=this.book.partyService.snapshot(ctx),currentOwners=new Set((currentParty?.characterIds??[]).map(id=>snapshot.characters.find(c=>c.id===id)?.ownerId));
          targets=targets.filter(u=>s.responses[u]?.state!=='no'&&currentOwners.has(u));
        }
        if(job.kind==='nudge')targets=targets.filter(u=>s.status==='poll'?!s.votes[u]||s.candidates.some(c=>!s.votes[u].known.includes(c.id)):!s.responses[u]||s.responses[u].state==='recheck');
        let eligible=[];for(const u of [...new Set(targets)])if(await this.canParticipate(channel,u))eligible.push(u);
        s=this.book.get(ctx,s.id);
        const latestParty=this.book.partyService.snapshot(ctx).parties.find(p=>p.id===s.partyId);
        if(this.obsolete(s,job)||(latestParty?.archived&&job.kind!=='cancelled')||(job.kind==='dropout'&&s.responses[data.userId]?.state!=='no')){
          this.db.prepare("UPDATE schedule_jobs SET state='obsolete' WHERE id=?").run(job.id);continue;
        }
        if(job.kind==='reminder')eligible=eligible.filter(u=>s.responses[u]?.state!=='no');
        const mentions=eligible.map(u=>`<@${u}>`).join(' '),title=`${s.partyName} · ${scheduleDate(s.startAt)}`;
        if(job.kind==='publish') {
          if(s.messageId&&!data.manual) {this.db.prepare("UPDATE schedule_jobs SET state='sent' WHERE id=?").run(job.id);continue;}
          const sent=await channel.send({...scheduleCard(s,this.book),content:data.announce?`${mentions}\n${s.status==='poll'?'보스 출발 시간 투표가 열렸어요.':'보스 일정이 등록됐어요.'}`:undefined,allowedMentions:{users:data.announce?eligible:[],parse:[]}});
          this.book.markMessage(ctx,s.id,sent.id,s.revision);
          this.db.prepare("UPDATE schedule_jobs SET state='resolved' WHERE schedule_id=? AND version=? AND kind='publish' AND state IN ('failed','unknown')").run(s.id,s.version);
        } else {
          if(job.kind==='reminder')text=`${title}\n약 ${Math.ceil((s.startAt-this.book.now())/60_000)}분 뒤 출발 예정입니다. 참석 ${s.members.filter(m=>['yes','regular'].includes(s.responses[m.userId]?.state)).length}/${s.members.length}명 · 일정을 확인해 주세요.`;
          if(job.kind==='confirmed')text=`${title}\n출발 시간이 확정됐어요.`;
          if(job.kind==='changed')text=`${title}\n일정이 변경됐어요.${data.beforeStartAt&&data.beforeStartAt!==s.startAt?`\n${scheduleDate(data.beforeStartAt)} → ${scheduleDate(s.startAt)}`:''}\n최신 시간과 재확인 필요 여부를 확인해 주세요.`;
          if(job.kind==='cancelled')text=`${title}\n이 회차는 취소됐어요.`;
          if(job.kind==='pollClosed')text=`${title}\n시간 투표가 마감됐어요. 결과를 보고 출발 시간을 확정해 주세요.`;
          if(job.kind==='dropout')text=`${title}\n참석자가 불참으로 변경했어요. 현재 인원 현황을 확인해 주세요.`;
          if(job.kind==='conflict')text=`${title}\n정기 회차에 겹치는 일정이 있어 검토가 필요해요.`;
          if(job.kind==='nudge')text=`${title}\n아직 응답하지 않은 일정이 있어요. 가능한 시간 또는 참석 여부를 알려 주세요.`;
          if(text&&(eligible.length||!['nudge','reminder'].includes(job.kind)))await channel.send({content:`${mentions}\n${text}`.slice(0,1900),components:scheduleCard(s,this.book).components,allowedMentions:{users:eligible,parse:[]}});
        }
        this.db.prepare("UPDATE schedule_jobs SET state='sent',error=NULL WHERE id=?").run(job.id);
        if(job.kind==='dropout')this.db.prepare("UPDATE schedule_jobs SET state='sent' WHERE schedule_id=? AND version=? AND kind='dropout' AND state='pending' AND due_at<=?").run(s.id,s.version,this.book.now());
      } catch(e) {
        const known=Number.isInteger(e.status)&&e.status>=400&&e.status<500;
        this.db.prepare('UPDATE schedule_jobs SET state=?,error=? WHERE id=?').run(known?'failed':'unknown',known?'발송 권한·채널 상태를 확인해 주세요.':'전송 결과를 확인하지 못했어요. 중복 전송을 막기 위해 자동 재전송하지 않아요.',job.id);
        console.warn('[schedule-send]',e.code??e.name);
      }
    }
    await this.onUpdate(ctx,channel).catch(()=>console.warn('[schedule-board] refresh-failed'));
  }
}
