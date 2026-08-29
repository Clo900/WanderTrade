/* ================================================
 * UI 基础组件
 * ================================================ */
// Toast 通知（居中偏上长条形）
function toast(msg,type='info'){const c=document.getElementById('toast-container');const d=document.createElement('div');d.className='toast '+type;d.textContent=msg;c.appendChild(d);setTimeout(()=>{d.style.opacity='0';d.style.transition='opacity 0.3s';setTimeout(()=>d.remove(),300)},2000)}
// 居中确认弹窗（msg 中的 \n 渲染为换行）
function showModal(title,msg,btnText,onOk){
  // 防止叠加导致无法点击/无法关闭
  document.querySelectorAll('.modal-overlay').forEach(o=>o.remove());
  const ov=document.createElement('div');
  ov.className='modal-overlay';
  ov.innerHTML=`<div class="modal-box"><h3>${title}</h3><p>${String(msg).replace(/\n/g,'<br>')}</p><div class="modal-btns"><button class="btn-cancel">取消</button><button class="btn-ok">${btnText}</button></div></div>`;
  document.body.appendChild(ov);
  ov.querySelector('.btn-ok').onclick=()=>{ov.remove();if(onOk)onOk();};
  ov.querySelector('.btn-cancel').onclick=()=>ov.remove();
  ov.onclick=function(e){if(e.target===ov)ov.remove()}
}
// 双按钮选择弹窗（私人事件等需要抉择的场景）
function showChoice(title,msg,btn1,btn2,on1,on2){
  document.querySelectorAll('.modal-overlay').forEach(o=>o.remove());
  const ov=document.createElement('div');
  ov.className='modal-overlay';
  ov.innerHTML=`<div class="modal-box"><h3>${title}</h3><p>${String(msg).replace(/\n/g,'<br>')}</p><div class="modal-btns"><button class="btn-ok" id="ch-1">${btn1}</button><button class="btn-cancel" id="ch-2">${btn2}</button></div></div>`;
  document.body.appendChild(ov);
  ov.querySelector('#ch-1').onclick=()=>{ov.remove();if(on1)on1();};
  ov.querySelector('#ch-2').onclick=()=>{ov.remove();if(on2)on2();};
  ov.onclick=function(e){if(e.target===ov){ov.remove();if(on2)on2();}}
}
// 全服跑马灯公告（顶部滚动横幅）：单机 /gm broadcast 本地演示 + 在线 GM 广播统一展示
// v9.9.2：内容以 ◆ 间隔符分隔；track 双份相同内容 + 0→-50% 动画无缝循环，常驻滚动；
//         替换新公告时先淡出再淡入（配合 .broadcast-bar 的 opacity 过渡）
function buildBroadcastTrack(bar,msg){
  const text=' 📢 '+String(msg==null?'':msg)+' ◆ ';
  // 估算单份宽度（中文/emoji 14px、ASCII 8px）；每组铺满约 1.1 屏，track 放 2 组实现无缝循环
  let unit=0;
  for(const ch of text){ unit += ch.charCodeAt(0)>127 ? 14 : 8; }
  const viewW=(window.innerWidth||1600);
  const perGroup=Math.max(2, Math.ceil((viewW*1.1)/unit));
  const track=document.createElement('div');
  track.className='broadcast-track';
  for(let g=0;g<2;g++){
    for(let i=0;i<perGroup;i++){
      const span=document.createElement('span');
      span.className='broadcast-text';
      span.textContent=text;
      track.appendChild(span);
    }
  }
  bar.innerHTML='';
  bar.appendChild(track);
}
let __broadcastSwap=null;
let __broadcastHide=null;
const BROADCAST_DURATION=20000; // v9.11.2：公告展示时长（ms），滚动约 1.3 遍足够阅读，随后自动淡出隐藏
function showBroadcast(msg){
  let bar=document.getElementById('broadcast-bar');
  clearTimeout(__broadcastHide); // 新公告到达：重置自动隐藏计时
  if(!bar){
    bar=document.createElement('div');
    bar.id='broadcast-bar';
    bar.className='broadcast-bar';
    document.body.appendChild(bar);
    buildBroadcastTrack(bar,msg);
    bar.classList.add('show'); // 首次出现：下滑+淡入
  }else{
    // 已有横幅：先淡出，再重建内容并淡入
    bar.classList.remove('show');
    clearTimeout(__broadcastSwap);
    __broadcastSwap=setTimeout(()=>{
      buildBroadcastTrack(bar,msg);
      bar.classList.add('show');
    },420);
  }
  // v9.11.2：展示期满自动淡出（避免横幅常驻顶部）
  __broadcastHide=setTimeout(()=>{ bar.classList.remove('show'); }, BROADCAST_DURATION+420);
}
window.toast = toast;
window.showModal = showModal;
window.showChoice = showChoice;
window.showBroadcast = showBroadcast;
