// One bounded, memory-only request shared by both UI entry points. This owns
// timing and feedback, never OCR evidence, choices or persistent preferences.
export const MANUAL_RECOGNITION_LIMIT_MS = 25000;
export const MANUAL_PANEL_WAIT_MS = 6000;
export const MANUAL_MESSAGES = Object.freeze({
  idle:'可识别三选一卡片，或核对已打开的六格强化符文面板。',
  scanning:'正在识别当前画面，请保持游戏及待识别内容可见。',
  checking:'正在核对六格强化符文面板，请保持面板可见。',
  saving:'面板核对已收到，正在保存本局记录。',
  saveFailed:'面板核对已收到，但本局记录未能保存；请核对已选记录后重试。',
  recognized:'已识别三个候选；尚未确认已选，请核对后选择。',
  confirmed:'六格面板核对已确认，已选海克斯和推荐已更新。',
  inferred:'同图标按推荐顺序推定已选，请核对；可手动纠正。',
  unavailable:'本次识别未完成，请保持游戏画面可见后重试。',
  ineligible:'请进入海克斯大乱斗对局后再识别。',
  noPending:'没有待核对的候选；请先显示三选一卡片。',
  noCapture:'缺少可核对的画面参考；请先显示三选一卡片，再打开六格面板。',
  rejected:'六格面板证据未通过校验；请保持面板清晰可见后重试。',
  cancelled:'本次识别已取消；对局、设置或手动选择已变化。',
  timeout:'本次识别超时，请核对本局已选记录；未记录时可保持画面重试。',
});

const sameContext = (left,right) => left && right
  && ['gameId','gameEpoch','revision','lifecycle','captureRevision'].every(key => left[key] === right[key]);

export class ManualRecognition {
  constructor({now = Date.now, timers = {setTimeout,clearTimeout}, onEnd = () => {}} = {}) {
    Object.assign(this,{now,timers,onEnd});
    this.sequence = 0;
    this.job = null;
    this.closed = false;
    this.state = {active:false,status:'idle',message:MANUAL_MESSAGES.idle,requestId:0,startedAt:0,expiresAt:0};
  }
  snapshot() { this.expire(); return {...this.state}; }
  expire() {
    if (this.job && this.now() >= this.job.expiresAt) this.finish(this.job,'timeout',MANUAL_MESSAGES.timeout);
  }
  sync(context) {
    this.expire();
    if (this.job && !sameContext(this.job.context,context)) this.cancel();
    return Boolean(this.job);
  }
  owns(job) { this.expire(); return this.job === job; }
  active(context) { return this.sync(context); }
  panelActive(context) { return this.active(context) && !this.job.committing; }
  begin(context) {
    if (this.job) return this.job;
    const startedAt = this.now(), requestId = ++this.sequence;
    const job = {context:{...context},requestId,startedAt,expiresAt:startedAt+MANUAL_RECOGNITION_LIMIT_MS};
    job.promise = new Promise(resolve => { job.resolve = resolve; });
    this.job = job;
    this.state = {active:true,status:'scanning',message:MANUAL_MESSAGES.scanning,requestId,startedAt,expiresAt:job.expiresAt};
    this.arm(job);
    return job;
  }
  arm(job) {
    this.timers.clearTimeout(job.timer);
    job.timer = this.timers.setTimeout(() => this.finish(job,'timeout',MANUAL_MESSAGES.timeout),Math.max(0,job.expiresAt-this.now()));
  }
  checking(job) {
    if (!this.owns(job)) return;
    job.expiresAt = Math.min(job.expiresAt,this.now()+MANUAL_PANEL_WAIT_MS);
    this.state = {...this.state,status:'checking',message:MANUAL_MESSAGES.checking,expiresAt:job.expiresAt};
    this.arm(job);
  }
  rebindAcceptedPanel(job,context) {
    if (this.owns(job)) {
      job.context = {...context};
      job.committing = true;
      this.state = {...this.state,status:'checking',message:MANUAL_MESSAGES.saving};
    }
  }
  finish(job,status,message,proposals = []) {
    if (!job || this.job !== job) return false;
    this.job = null;
    this.timers.clearTimeout(job.timer);
    this.state = {...this.state,active:false,status,message};
    this.onEnd(job);
    job.resolve({status,message,proposals:proposals.map(value => ({...value})),manualRecognition:{...this.state}});
    return true;
  }
  unavailable(message) {
    const job = this.begin(null);
    this.finish(job,'unavailable',message);
    return job.promise;
  }
  cancel() { if (this.job) this.finish(this.job,'cancelled',MANUAL_MESSAGES.cancelled); }
  reset() {
    this.cancel();
    this.state = {active:false,status:'idle',message:'',requestId:this.sequence,startedAt:0,expiresAt:0};
  }
  close() { this.closed = true; this.cancel(); }
}
