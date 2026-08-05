const STATUS = {
  DRAFT:"Borrador",INVITED:"Invitado",AWAITING_CONSENT:"Esperando consentimiento",ACTIVE:"En proceso",PAUSED:"Pausado",
  WAITING_FOR_CLIENT:"Esperando cliente",NEEDS_STAFF_REVIEW:"Revisión necesaria",READY_FOR_REVIEW:"Listo para revisar",
  COMPLETE:"Completo",DECLINED:"No aceptó",DELETION_REQUESTED:"Borrado solicitado"
};
const state={clients:[],current:null,system:null};
const $=(selector)=>document.querySelector(selector);
const el=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node};

async function api(url,options={}){
  const response=await fetch(url,{headers:{"Content-Type":"application/json",...(options.headers||{})},...options});
  const data=response.status===204?null:await response.json().catch(()=>({error:"Respuesta inválida"}));
  if(!response.ok)throw new Error(data?.error||`Error ${response.status}`);
  return data;
}
function toast(message){const node=$("#toast");node.textContent=message;node.classList.add("show");clearTimeout(toast.timer);toast.timer=setTimeout(()=>node.classList.remove("show"),2600)}
function initials(name){return(name||"?").split(/\s+/).slice(0,2).map(x=>x[0]).join("").toUpperCase()}
function statusClass(status){return ["ACTIVE","READY_FOR_REVIEW"].includes(status)?"active":["NEEDS_STAFF_REVIEW","WAITING_FOR_CLIENT"].includes(status)?"review":status==="PAUSED"?"paused":""}
function formatDate(value){if(!value)return"";const match=String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);return match?`${match[3]}/${match[2]}/${match[1]}`:value==="CURRENT"?"ACTUAL":String(value).replace(/^(\d{4})-(\d{2})$/, "$2/$1")}
function valueText(value){if(value===true)return"Sí";if(value===false)return"No";return value==null?"":formatDate(value)}

async function loadSystem(){
  try{
    state.system=await api("/api/system/status");
    const organization=state.system.organizationName||"ACME";$("#organizationName").textContent=organization;document.title=`${organization} · Client Intake Automation`;
    const wa=$("#whatsappStatus"),drive=$("#driveStatus");
    wa.className="connection "+(state.system.whatsapp.state==="READY"?"ready":state.system.whatsapp.state==="QR"?"warn":"");
    wa.querySelector("b").textContent={READY:"Conectado",QR:"Escanear QR",AUTHENTICATED:"Autenticando",STARTING:"Iniciando",DISCONNECTED:"Desconectado",ERROR:"Error"}[state.system.whatsapp.state]||state.system.whatsapp.state;
    const ds=state.system.googleDrive;
    drive.className="connection "+(ds.connected?"ready":"warn");
    drive.querySelector("b").textContent=ds.connected?"Conectado":ds.configured?"Conectar":"Configurar";
    if(ds.connected&&ds.rootFolderLink){drive.href=ds.rootFolderLink;drive.target="_blank"}else{drive.href="/auth/google";drive.removeAttribute("target")}
    const qr=state.system.whatsapp.qrDataUrl;
    $("#qrImage").hidden=!qr;$(".qr-placeholder").hidden=Boolean(qr);if(qr)$("#qrImage").src=qr;
  }catch(error){console.error(error)}
}

async function loadClients(){
  state.clients=await api("/api/clients");
  renderMetrics();renderClients();
}
function renderMetrics(){
  $("#metricTotal").textContent=state.clients.length;
  $("#metricActive").textContent=state.clients.filter(c=>["ACTIVE","AWAITING_CONSENT","WAITING_FOR_CLIENT"].includes(c.status)).length;
  $("#metricReview").textContent=state.clients.filter(c=>["NEEDS_STAFF_REVIEW","READY_FOR_REVIEW"].includes(c.status)).length;
  $("#metricDocuments").textContent=state.clients.reduce((sum,c)=>sum+c.documentCount,0);
}
function renderClients(){
  const query=$("#searchInput").value.trim().toLowerCase(),filter=$("#statusFilter").value;
  const clients=state.clients.filter(c=>(!filter||c.status===filter)&&(!query||`${c.displayName} ${c.phone}`.toLowerCase().includes(query)));
  const body=$("#clientRows");body.replaceChildren();$("#emptyState").hidden=clients.length>0;$("#resultCount").textContent=`${clients.length} registro${clients.length===1?"":"s"}`;
  for(const client of clients){
    const row=el("tr");
    const identity=el("td"),wrap=el("div","client-cell"),avatar=el("div","avatar",initials(client.displayName));
    const names=el("div");names.append(el("b",null,client.displayName||"Sin nombre"),el("span",null,client.phone));wrap.append(avatar,names);identity.append(wrap);
    const status=el("td");status.append(el("span",`badge ${statusClass(client.status)}`,STATUS[client.status]||client.status));
    const progress=el("td"),progressWrap=el("div","progress-cell"),track=el("div","mini-track"),bar=el("i");bar.style.width=`${client.progress.percent}%`;track.append(bar);progressWrap.append(track,el("b",null,`${client.progress.percent}%`));progress.append(progressWrap);
    const docs=el("td"),docWrap=el("div","doc-count");docWrap.append(el("span",null,"▱"),el("b",null,String(client.documentCount)));if(client.pendingDocumentCount)docWrap.append(el("span","badge review",`${client.pendingDocumentCount} pendiente`));docs.append(docWrap);
    const updated=el("td",null,new Date(client.updatedAt).toLocaleString("es-MX",{dateStyle:"medium",timeStyle:"short"}));
    const action=el("td"),button=el("button","row-open","Abrir →");button.onclick=()=>openClient(client.id);action.append(button);
    row.append(identity,status,progress,docs,updated,action);row.ondblclick=()=>openClient(client.id);body.append(row);
  }
}

async function openClient(id){
  state.current=await api(`/api/clients/${encodeURIComponent(id)}`);
  const c=state.current;$("#detailAvatar").textContent=initials(c.displayName);$("#detailName").value=c.displayName;$("#detailPhone").textContent=c.phoneE164;
  $("#detailPercent").textContent=`${c.progress.percent}%`;$("#detailProgressBar").style.width=`${c.progress.percent}%`;
  const select=$("#detailStatus");select.replaceChildren(...Object.entries(STATUS).map(([value,label])=>{const option=el("option",null,label);option.value=value;option.selected=value===c.status;return option}));
  $("#detailNotes").value=c.notes||"";renderInformation();renderDocuments();renderCustom();showTab("information");if(!$("#clientDialog").open)$("#clientDialog").showModal();
}
function renderInformation(){
  const root=$("#informationTab");root.replaceChildren();const groups=new Map();
  for(const field of state.current.fields){if(field.forms?.includes("INTERNAL"))continue;if(!groups.has(field.section))groups.set(field.section,[]);groups.get(field.section).push(field)}
  for(const [section,fields] of groups){
    const card=el("article","field-section"),heading=el("div","section-heading"),title=el("div");title.append(el("h3",null,section),el("p",null,`${fields.filter(f=>state.current.answers[f.id]?.status==="CONFIRMED").length} de ${fields.filter(f=>f.required).length} requeridos confirmados`));heading.append(title);card.append(heading);
    const grid=el("div","fields-grid");
    for(const field of fields){
      const row=el("div","field-row"),label=el("label",null,field.label+(field.required?" *":"")),control=el("div","field-control"),answer=state.current.answers[field.id];let input;
      if(field.kind==="yes_no"){input=el("select");for(const [v,t] of [["","Sin dato"],["Sí","Sí"],["No","No"]]){const o=el("option",null,t);o.value=v;o.selected=valueText(answer?.value)===v;input.append(o)}}
      else{input=el("input");input.value=valueText(answer?.value);input.placeholder=answer?.status==="PENDING"?"Pendiente":"Sin dato";if(field.kind==="email")input.type="email"}
      input.onchange=async()=>{if(!input.value)return;try{await api(`/api/clients/${state.current.id}/answers/${encodeURIComponent(field.id)}`,{method:"PUT",body:JSON.stringify({value:input.value})});toast("Dato guardado");await openClient(state.current.id)}catch(error){toast(error.message)}};
      control.append(input,el("span","field-status",answer?{CONFIRMED:"Confirmado",PENDING:"Pendiente",PROPOSED:"Propuesto",CONFLICT:"Conflicto"}[answer.status]:"Faltante"));row.append(label,control);grid.append(row);
    }
    card.append(grid);root.append(card);
  }
}
function renderDocuments(){
  const root=$("#documentsTab");root.replaceChildren();const header=el("div","documents-header"),copy=el("div");copy.append(el("h3",null,"Documentos del cliente"),el("p",null,"Archivos almacenados en Google Drive."));header.append(copy);
  if(state.current.driveFolderLink){const link=el("a","drive-folder","Abrir carpeta en Drive ↗");link.href=state.current.driveFolderLink;link.target="_blank";link.rel="noopener";header.append(link)}root.append(header);
  const grid=el("div","documents-grid");for(const doc of state.current.documents){const card=el("article","document-card");card.append(el("div","document-icon",doc.mimeType==="application/pdf"?"PDF":"▧"),el("b",null,doc.name),el("span",null,`${(doc.size/1024/1024).toFixed(2)} MB · ${new Date(doc.createdAt).toLocaleDateString("es-MX")}`));const link=el("a",null,"Visualizar en Google Drive ↗");link.href=doc.webViewLink;link.target="_blank";link.rel="noopener";card.append(link);grid.append(card)}
  if(!state.current.documents.length)grid.append(el("p",null,"Todavía no hay documentos guardados."));root.append(grid);$("#documentBadge").textContent=state.current.documents.length;
}
function renderCustom(){
  const root=$("#customFields");root.replaceChildren();for(const item of state.current.customFields){const row=el("div","custom-item");row.append(el("b",null,item.label),el("span",null,item.value));const remove=el("button",null,"Eliminar");remove.onclick=async()=>{await api(`/api/clients/${state.current.id}/custom-fields/${item.id}`,{method:"DELETE"});await refreshCurrent()};row.append(remove);root.append(row)}
}
async function refreshCurrent(){await openClient(state.current.id);await loadClients()}
function showTab(tab){document.querySelectorAll(".tabs button").forEach(b=>b.classList.toggle("active",b.dataset.tab===tab));for(const name of ["information","documents","extras"])$(`#${name}Tab`).hidden=name!==tab}

for(const [value,label] of Object.entries(STATUS)){const option=el("option",null,label);option.value=value;$("#statusFilter").append(option)}
$("#searchInput").oninput=renderClients;$("#statusFilter").onchange=renderClients;$("#closeDialog").onclick=()=>$("#clientDialog").close();$("#closeSetup").onclick=()=>$("#setupDialog").close();
document.querySelectorAll(".tabs button").forEach(button=>button.onclick=()=>showTab(button.dataset.tab));
$("#whatsappStatus").onclick=()=>{if(state.system?.whatsapp.state==="QR")$("#setupDialog").showModal();else toast(state.system?.whatsapp.lastError||`WhatsApp: ${state.system?.whatsapp.state}`)};
$("#backupButton").onclick=async()=>{try{const data=await api("/api/system/backup",{method:"POST"});toast(`Respaldo creado: ${data.filename}`)}catch(error){toast(error.message)}};
$("#detailName").onchange=async()=>{await api(`/api/clients/${state.current.id}`,{method:"PATCH",body:JSON.stringify({displayName:$("#detailName").value})});toast("Nombre actualizado");await loadClients()};
$("#detailStatus").onchange=async()=>{await api(`/api/clients/${state.current.id}`,{method:"PATCH",body:JSON.stringify({status:$("#detailStatus").value})});toast("Estado actualizado");await loadClients()};
$("#saveNotes").onclick=async()=>{await api(`/api/clients/${state.current.id}`,{method:"PATCH",body:JSON.stringify({notes:$("#detailNotes").value})});toast("Notas guardadas")};
$("#customFieldForm").onsubmit=async(event)=>{event.preventDefault();const form=new FormData(event.target);try{await api(`/api/clients/${state.current.id}/custom-fields`,{method:"POST",body:JSON.stringify({label:form.get("label"),value:form.get("value")})});event.target.reset();await refreshCurrent();toast("Dato agregado")}catch(error){toast(error.message)}};

await Promise.all([loadSystem(),loadClients()]);setInterval(loadSystem,3000);setInterval(loadClients,10000);
