/* ================================================
 * UI 基础组件
 * ================================================ */
// Toast 通知（居中偏上长条形）
function toast(msg,type='info'){const c=document.getElementById('toast-container');const d=document.createElement('div');d.className='toast '+type;d.textContent=msg;c.appendChild(d);setTimeout(()=>{d.style.opacity='0';d.style.transition='opacity 0.3s';setTimeout(()=>d.remove(),300)},2000)}
// 居中确认弹窗（msg 中的 \n 渲染为换行）
function showModal(title,msg,btnText,onOk){const ov=document.createElement('div');ov.className='modal-overlay';ov.innerHTML=`<div class="modal-box"><h3>${title}</h3><p>${String(msg).replace(/\n/g,'<br>')}</p><div class="modal-btns"><button class="btn-cancel">取消</button><button class="btn-ok">${btnText}</button></div></div>`;document.body.appendChild(ov);ov.querySelector('.btn-ok').onclick=()=>{ov.remove();onOk();};ov.querySelector('.btn-cancel').onclick=()=>ov.remove();ov.onclick=function(e){if(e.target===ov)ov.remove()}}
// 双按钮选择弹窗（私人事件等需要抉择的场景）
function showChoice(title,msg,btn1,btn2,on1,on2){const ov=document.createElement('div');ov.className='modal-overlay';ov.innerHTML=`<div class="modal-box"><h3>${title}</h3><p>${String(msg).replace(/\n/g,'<br>')}</p><div class="modal-btns"><button class="btn-ok" id="ch-1">${btn1}</button><button class="btn-cancel" id="ch-2">${btn2}</button></div></div>`;document.body.appendChild(ov);ov.querySelector('#ch-1').onclick=()=>{ov.remove();if(on1)on1();};ov.querySelector('#ch-2').onclick=()=>{ov.remove();if(on2)on2();};ov.onclick=function(e){if(e.target===ov){ov.remove();if(on2)on2();}}}
window.toast = toast;
window.showModal = showModal;
window.showChoice = showChoice;
