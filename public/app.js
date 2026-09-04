const STATUS = {
  DRAFT:"Borrador",INVITED:"Invitado",AWAITING_CONSENT:"Esperando consentimiento",ACTIVE:"En proceso",PAUSED:"Pausado",STOPPED_BY_ADMIN:"Detenido por administrador",
  WAITING_FOR_CLIENT:"Esperando cliente",NEEDS_STAFF_REVIEW:"Revisión necesaria",READY_FOR_REVIEW:"Listo para revisar",
  COMPLETE:"Completo",DECLINED:"No aceptó",DELETION_REQUESTED:"Borrado solicitado"
};
const state={clients:[],usaClients:[],current:null,currentWorkflow:"canada",system:null,pendingOnly:false,clientSort:{key:"updatedAt",direction:"desc"}};
const WORKSPACE_HELP={
  canada:{eyebrow:"Visa Canadá",title:"Ayuda del sistema de visas canadienses",intro:"Este módulo está activo y concentra el flujo actual de expedientes.",features:[
    ["Iniciar el bot","Desde la cuenta vinculada, envía START BOT CANADA en el chat individual del cliente."],
    ["Detener o reanudar","Envía STOP BOT para detener cualquier flujo. START BOT CANADA permite retomarlo sin perder el avance."],
    ["Bot normal o con IA","Usa el interruptor Modo de respuesta en la parte superior. El bot normal sigue el formulario literalmente; el bot con IA entiende respuestas más naturales. Tu elección queda guardada."],
    ["Consultar el expediente","Abre un cliente en la tabla para revisar respuestas, progreso, documentos, notas y datos adicionales."],
    ["Archivos en Google Drive","Cada cliente tiene una carpeta propia. Puedes abrirla desde la pestaña Documentos dentro de su expediente."],
    ["PDF y correo","Desde el expediente puedes descargar el resumen PDF o enviarlo al correo confirmado del cliente."]
  ]},
  usa:{eyebrow:"Visa USA",title:"Ayuda del sistema de visas estadounidenses",intro:"Este módulo funciona de manera independiente al sistema de Canadá.",features:[
    ["Iniciar el bot","Envía START BOT USA en el chat individual del cliente."],
    ["Detener o reanudar","Envía STOP BOT para detener cualquier flujo. START BOT USA retoma el avance guardado."],
    ["Bot normal o con IA","Usa el interruptor Modo de respuesta en la parte superior. Puedes cambiarlo en cualquier momento sin reiniciar WhatsApp ni perder avances."],
    ["Expedientes","La tabla muestra únicamente solicitudes USA y permite revisar respuestas, progreso, documentos y notas."],
    ["Google Drive","Cada cliente USA utiliza una carpeta dentro de una raíz independiente para Visa USA."],
    ["Almacenamiento","Los expedientes USA viven en una base SQLite separada de los expedientes de Canadá."]
  ]},
  eta:{eyebrow:"eTA Canadá",title:"Ayuda del sistema eTA",intro:"Esta pestaña reserva un espacio independiente para las autorizaciones electrónicas de viaje.",features:[
    ["Estado actual","La automatización de eTA todavía no está habilitada."],
    ["Inicio y detención","Crearemos comandos propios para que el flujo no se mezcle con las visas regulares de Canadá."],
    ["Requisitos","Se definirá un mensaje informativo específico para solicitudes eTA."],
    ["Google Drive","Los documentos se almacenarán en una estructura separada, que se mostrará desde cada expediente eTA."]
  ]},
  companies:{eyebrow:"Empresas en Canadá",title:"Ayuda del registro de empresas",intro:"Esta pestaña será el espacio independiente para procesos corporativos en Canadá.",features:[
    ["Estado actual","El flujo de registro de empresas todavía no está habilitado."],
    ["Inicio y seguimiento","Se definirán acciones propias para crear, pausar y continuar cada proceso corporativo."],
    ["Requisitos","Se preparará una lista específica según el tipo de empresa y la provincia de registro."],
    ["Google Drive","Cada empresa tendrá una carpeta independiente para documentos, formularios y entregables."]
  ]}
};
const $=(selector)=>document.querySelector(selector);
const el=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node};

async function api(url,options={}){
  const headers={...(options.headers||{})};if(options.body!==undefined&&!Object.keys(headers).some(key=>key.toLowerCase()==="content-type"))headers["Content-Type"]="application/json";
  const response=await fetch(url,{...options,headers});
  const data=response.status===204?null:await response.json().catch(()=>({error:"Respuesta inválida"}));
  if(!response.ok){const error=new Error(data?.error||`Error ${response.status}`);error.code=data?.code;error.authorizationUrl=data?.authorizationUrl;throw error}
  return data;
}
function toast(message){const node=$("#toast");node.textContent=message;node.classList.add("show");clearTimeout(toast.timer);toast.timer=setTimeout(()=>node.classList.remove("show"),2600)}
function initials(name){return(name||"?").split(/\s+/).slice(0,2).map(x=>x[0]).join("").toUpperCase()}
function statusClass(status){return ["ACTIVE","READY_FOR_REVIEW"].includes(status)?"active":["NEEDS_STAFF_REVIEW","WAITING_FOR_CLIENT"].includes(status)?"review":["PAUSED","STOPPED_BY_ADMIN"].includes(status)?"paused":""}
function formatDate(value){if(value===null||value===undefined||value==="")return"";const match=String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);return match?`${match[3]}/${match[2]}/${match[1]}`:value==="CURRENT"?"ACTUAL":String(value).replace(/^(\d{4})-(\d{2})$/, "$2/$1")}
function valueText(value){if(value===true)return"Sí";if(value===false)return"No";return value==null?"":formatDate(value)}
function formatTimestamp(value){return value?new Date(value).toLocaleString("es-MX",{dateStyle:"medium",timeStyle:"short"}):""}
function shortText(value,limit=180){const text=String(value??"").replace(/\s+/g," ").trim();return text.length>limit?`${text.slice(0,limit-1)}…`:text}
function isTimelineError(event){return /FAILED|ERROR|REJECTED/.test(event.event)}

function renderWhatsAppAlert(status=null,requestError=null){
  const alert=$("#whatsappAlert"),title=$("#whatsappAlertTitle"),message=$("#whatsappAlertMessage"),button=$("#whatsappAlertAction");
  if(!requestError&&status?.state==="READY"){alert.hidden=true;return}
  const needsAttention=requestError||["ERROR","DISCONNECTED","QR"].includes(status?.state);
  if(!needsAttention){alert.hidden=true;return}
  alert.hidden=false;alert.classList.toggle("warning",status?.state==="QR");
  if(requestError){title.textContent="No se puede verificar la conexión";message.textContent="El panel no pudo consultar si WhatsApp está funcionando.";button.textContent="Reintentar";alert.title=requestError.message||"";return}
  if(status.state==="QR"){title.textContent="WhatsApp necesita vincularse";message.textContent="El bot no recibirá mensajes hasta que se escanee el código QR.";button.textContent="Mostrar QR"}
  else{title.textContent="WhatsApp está desconectado";message.textContent="El dashboard está disponible, pero el bot no puede recibir ni enviar mensajes. El supervisor intentará recuperarlo.";button.textContent="Ver detalle"}
  alert.title=status.lastError||"";
}

function clientPending(client){return Math.max(0,client.progress.required-client.progress.confirmed)}
function clientSortValue(client,key){
  if(key==="status")return STATUS[client.status]||client.status;
  if(key==="progress")return client.progress.percent;
  if(key==="pending")return clientPending(client);
  if(key==="documents")return client.documentCount;
  if(key==="createdAt"||key==="updatedAt")return Date.parse(client[key])||0;
  return client[key]||"";
}
function compareClients(left,right){
  const {key,direction}=state.clientSort,a=clientSortValue(left,key),b=clientSortValue(right,key);
  const result=typeof a==="number"&&typeof b==="number"?a-b:String(a).localeCompare(String(b),"es",{numeric:true,sensitivity:"base"});
  return (direction==="asc"?result:-result)||String(left.id).localeCompare(String(right.id));
}
function renderSortHeaders(){
  document.querySelectorAll(".sort-button").forEach(button=>{
    const active=button.dataset.sort===state.clientSort.key;
    button.setAttribute("aria-sort",active?(state.clientSort.direction==="asc"?"ascending":"descending"):"none");
    let indicator=button.querySelector(".sort-indicator");
    if(!indicator){indicator=el("span","sort-indicator");button.append(indicator)}
    indicator.textContent=active?(state.clientSort.direction==="asc"?"▲":"▼"):"↕";
  });
}
async function deleteClientRecord(client,workflow){
  const service=workflow==="usa"?"Visa USA":"Visa Canadá";
  const name=client.displayName||client.phone||"este cliente";
  const confirmed=window.confirm(`¿Eliminar por completo el expediente de ${name}?\n\nServicio: ${service}\n\nSe eliminarán permanentemente el registro, todas sus respuestas, documentos y su carpeta de Google Drive. Esta acción no se puede deshacer.`);
  if(!confirmed)return;
  try{
    const base=workflow==="usa"?"/api/usa/clients":"/api/clients";
    const result=await api(`${base}/${encodeURIComponent(client.id)}`,{method:"DELETE"});
    toast(result.driveFolderDeleted===false?"Expediente eliminado; la carpeta de Drive no pudo borrarse":"Expediente eliminado por completo");
    await (workflow==="usa"?loadUsaClients():loadClients());
  }catch(error){toast(error.message)}
}
function showWorkspace(workspace){
  document.querySelectorAll(".workspace-tabs button").forEach(button=>button.classList.toggle("active",button.dataset.workspace===workspace));
  for(const name of ["canada","usa","eta","companies","manual"])$(`#${name}Workspace`).hidden=name!==workspace;
}
function showWorkspaceHelp(workspace){
  const help=WORKSPACE_HELP[workspace];if(!help)return;
  $("#workspaceHelpEyebrow").textContent=help.eyebrow;$("#workspaceHelpTitle").textContent=help.title;$("#workspaceHelpIntro").textContent=help.intro;
  const root=$("#workspaceHelpFeatures");root.replaceChildren();
  for(const [title,description] of help.features){const item=el("div","help-feature");item.append(el("b",null,title),el("span",null,description));root.append(item)}
  $("#workspaceHelpDialog").showModal();
}

async function loadSystem(){
  try{
    state.system=await api("/api/system/status");
    const organization=state.system.organizationName||"MultiServicios";$("#organizationName").textContent=organization;document.title=`${organization} · Control de expedientes`;
    const wa=$("#whatsappStatus"),drive=$("#driveStatus");
    wa.className="connection "+(state.system.whatsapp.state==="READY"?"ready":["QR","BACKUP"].includes(state.system.whatsapp.state)?"warn":"");
    wa.querySelector("b").textContent={READY:"Conectado",QR:"Escanear QR",AUTHENTICATED:"Autenticando",STARTING:"Iniciando",BACKUP:"Respaldando",DISCONNECTED:"Desconectado",ERROR:"Error"}[state.system.whatsapp.state]||state.system.whatsapp.state;
    renderAiToggle();
    const ds=state.system.googleDrive;
    drive.className="connection "+(ds.connected?"ready":"warn");
    drive.querySelector("b").textContent=ds.connected?"Conectado":ds.configured?"Conectar":"Configurar";
    drive.title=ds.connected?(ds.gmailSendAuthorized?"Drive y envío por Gmail autorizados":"Drive conectado; falta autorizar el envío por Gmail"):"Conectar Google";
    if(ds.connected&&ds.rootFolderLink){drive.href=ds.rootFolderLink;drive.target="_blank"}else{drive.href="/auth/google";drive.removeAttribute("target")}
    const qr=state.system.whatsapp.qrDataUrl;
    $("#qrImage").hidden=!qr;$(".qr-placeholder").hidden=Boolean(qr);if(qr)$("#qrImage").src=qr;
    renderAutomationToggle();
    renderWhatsAppAlert(state.system.whatsapp);
  }catch(error){console.error(error);renderWhatsAppAlert(null,error)}
}
function renderAutomationToggle(){
  const button=$("#automationToggle"),paused=Boolean(state.system?.whatsapp?.automationPaused);
  button.classList.toggle("paused",paused);button.setAttribute("aria-pressed",String(paused));button.title=paused?"Continuar automatización":"Pausar automatización";
  button.querySelector(".automation-icon").textContent=paused?"▶":"⏸";button.querySelector("b").textContent=paused?"Pausado":"En ejecución";
}
function renderAiToggle(){
  const button=$("#aiToggle"),aiState=state.system?.aiConversation||{},enabled=Boolean(aiState.enabled);
  button.classList.toggle("enabled",enabled&&Boolean(aiState.configured));button.classList.toggle("warn",enabled&&!aiState.configured);
  button.setAttribute("aria-pressed",String(enabled));
  button.querySelector("b").textContent=enabled?(aiState.configured?"Bot con IA":"IA sin configurar"):"Bot normal";
  button.title=aiState.lastError||(!enabled?"Activar bot con IA":aiState.configured?`Cambiar a bot normal. Modelo actual: ${aiState.model}`:"Falta configurar la clave de OpenAI");
}

async function loadClients(){
  state.clients=await api("/api/clients");
  renderMetrics();renderClients();
}
async function loadUsaClients(){
  state.usaClients=await api("/api/usa/clients");
  $("#usaMetricTotal").textContent=state.usaClients.length;
  $("#usaMetricActive").textContent=state.usaClients.filter(c=>["ACTIVE","AWAITING_CONSENT","WAITING_FOR_CLIENT"].includes(c.status)).length;
  $("#usaMetricReview").textContent=state.usaClients.filter(c=>["NEEDS_STAFF_REVIEW","READY_FOR_REVIEW"].includes(c.status)).length;
  $("#usaMetricDocuments").textContent=state.usaClients.reduce((sum,c)=>sum+c.documentCount,0);
  renderUsaClients();
}
function renderMetrics(){
  $("#metricTotal").textContent=state.clients.length;
  $("#metricActive").textContent=state.clients.filter(c=>["ACTIVE","AWAITING_CONSENT","WAITING_FOR_CLIENT"].includes(c.status)).length;
  $("#metricReview").textContent=state.clients.filter(c=>["NEEDS_STAFF_REVIEW","READY_FOR_REVIEW"].includes(c.status)).length;
  $("#metricDocuments").textContent=state.clients.reduce((sum,c)=>sum+c.documentCount,0);
}
function renderClients(){
  const query=$("#searchInput").value.trim().toLowerCase(),filter=$("#statusFilter").value;
  const clients=state.clients.filter(c=>(!filter||c.status===filter)&&(!query||`${c.displayName} ${c.phone}`.toLowerCase().includes(query))).sort(compareClients);
  renderSortHeaders();
  const body=$("#clientRows");body.replaceChildren();$("#emptyState").hidden=clients.length>0;$("#resultCount").textContent=`${clients.length} registro${clients.length===1?"":"s"}`;
  for(const client of clients){
    const row=el("tr");
    const identity=el("td"),wrap=el("div","client-cell"),avatar=el("div","avatar",initials(client.displayName));
    const names=el("div");names.append(el("b",null,client.displayName||"Sin nombre"));wrap.append(avatar,names);identity.append(wrap);
    const phone=el("td",null,client.phone||"—");
    const status=el("td");status.append(el("span",`badge ${statusClass(client.status)}`,STATUS[client.status]||client.status));
    const progress=el("td"),progressWrap=el("div","progress-cell"),track=el("div","mini-track"),bar=el("i");bar.style.width=`${client.progress.percent}%`;track.append(bar);progressWrap.append(track,el("b",null,`${client.progress.percent}%`));progress.append(progressWrap);
    const docs=el("td"),docWrap=el("div","doc-count");docWrap.append(el("span",null,"▱"),el("b",null,String(client.documentCount)));if(client.pendingDocumentCount)docWrap.append(el("span","badge review",`${client.pendingDocumentCount} pendiente`));docs.append(docWrap);
    const updated=el("td",null,new Date(client.updatedAt).toLocaleString("es-MX",{dateStyle:"medium",timeStyle:"short"}));
    const action=el("td"),actionWrap=el("div","row-actions"),pdf=el("a","row-pdf","Descargar PDF"),button=el("button","row-open","Abrir →"),remove=el("button","row-delete","🗑️");
    pdf.href=`/api/clients/${encodeURIComponent(client.id)}/pdf`;pdf.setAttribute("download","");pdf.onclick=(event)=>event.stopPropagation();
    button.onclick=()=>openClient(client.id);remove.title="Eliminar expediente";remove.setAttribute("aria-label",`Eliminar expediente de ${client.displayName||client.phone}`);remove.onclick=(event)=>{event.stopPropagation();void deleteClientRecord(client,"canada")};actionWrap.append(pdf,button,remove);action.append(actionWrap);
    const pendingCount=clientPending(client),pending=el("td");pending.append(el("span",pendingCount?"badge review":"badge active",String(pendingCount)));
    const created=el("td",null,new Date(client.createdAt).toLocaleDateString("es-MX",{dateStyle:"medium"}));
    row.append(identity,phone,status,progress,pending,docs,created,updated,action);row.ondblclick=()=>openClient(client.id);body.append(row);
  }
}

function renderUsaClients(){
  const query=$("#usaSearchInput").value.trim().toLowerCase();
  const clients=state.usaClients.filter(c=>!query||`${c.displayName} ${c.phone}`.toLowerCase().includes(query)).sort(compareClients);
  const body=$("#usaClientRows");body.replaceChildren();$("#usaEmptyState").hidden=clients.length>0;$("#usaResultCount").textContent=`${clients.length} registro${clients.length===1?"":"s"}`;
  for(const client of clients){
    const row=el("tr"),identity=el("td"),wrap=el("div","client-cell"),avatar=el("div","avatar",initials(client.displayName)),names=el("div");names.append(el("b",null,client.displayName||"Sin nombre"));wrap.append(avatar,names);identity.append(wrap);
    const phone=el("td",null,client.phone||"—"),status=el("td");status.append(el("span",`badge ${statusClass(client.status)}`,STATUS[client.status]||client.status));
    const progress=el("td"),progressWrap=el("div","progress-cell"),track=el("div","mini-track"),bar=el("i");bar.style.width=`${client.progress.percent}%`;track.append(bar);progressWrap.append(track,el("b",null,`${client.progress.percent}%`));progress.append(progressWrap);
    const pendingCount=clientPending(client),pending=el("td");pending.append(el("span",pendingCount?"badge review":"badge active",String(pendingCount)));
    const docs=el("td",null,String(client.documentCount)),created=el("td",null,new Date(client.createdAt).toLocaleDateString("es-MX",{dateStyle:"medium"})),updated=el("td",null,new Date(client.updatedAt).toLocaleString("es-MX",{dateStyle:"medium",timeStyle:"short"}));
    const action=el("td"),actionWrap=el("div","row-actions"),button=el("button","row-open","Abrir →"),remove=el("button","row-delete","🗑️");button.onclick=()=>openClient(client.id,"usa");remove.title="Eliminar expediente";remove.setAttribute("aria-label",`Eliminar expediente de ${client.displayName||client.phone}`);remove.onclick=(event)=>{event.stopPropagation();void deleteClientRecord(client,"usa")};actionWrap.append(button,remove);action.append(actionWrap);row.append(identity,phone,status,progress,pending,docs,created,updated,action);row.ondblclick=()=>openClient(client.id,"usa");body.append(row);
  }
}

function currentClientBase(){return state.currentWorkflow==="usa"?"/api/usa/clients":"/api/clients"}
async function openClient(id,workflow="canada"){
  state.currentWorkflow=workflow;
  state.current=await api(`${currentClientBase()}/${encodeURIComponent(id)}`);
  const c=state.current;$("#detailAvatar").textContent=initials(c.displayName);$("#detailName").value=c.displayName;$("#detailPhone").textContent=c.phoneE164;
  $("#detailPercent").textContent=`${c.progress.percent}%`;$("#detailProgressBar").style.width=`${c.progress.percent}%`;
  const answer=(id)=>valueText(c.answers[id]?.value)||"Sin dato";
  $("#quickEmail").textContent=answer("contact.email");$("#quickPhone").textContent=answer("contact.phone");$("#quickAddress").textContent=answer("contact.residential_address");
  $("#downloadPdf").href=`${currentClientBase()}/${encodeURIComponent(c.id)}/pdf`;
  $("#emailPdf").disabled=!c.answers["contact.email"]?.value;$("#emailPdf").title=c.answers["contact.email"]?.value?`Enviar a ${c.answers["contact.email"].value}`:"El cliente todavía no ha proporcionado su correo";
  const select=$("#detailStatus");select.replaceChildren(...Object.entries(STATUS).map(([value,label])=>{const option=el("option",null,label);option.value=value;option.selected=value===c.status;return option}));
  $("#detailNotes").value=c.notes||"";renderInformation();renderActivity();renderDocuments();renderCustom();showTab("information");if(!$("#clientDialog").open)$("#clientDialog").showModal();
}
function displaySection(field){return field.displaySection||field.section}
function renderFieldRow(field,compact=false){
  const answer=state.current.answers[field.id],current=valueText(answer?.value),row=el("div",`field-row ${answer?.status?.toLowerCase()||"missing"}${compact?" employment-cell":""}`),label=el("label",null,field.label+(field.required?" *":"")),control=el("div","field-control");let input;
  if(field.kind==="yes_no"){
    input=el("select");
    for(const [value,text] of [["","Sin dato"],["Sí","Sí"],["No","No"]]){const option=el("option",null,text);option.value=value;option.selected=current===value;input.append(option)}
  }else{
    const multiline=field.kind==="text"&&current.length>55;
    input=el(multiline?"textarea":"input");input.value=current;input.placeholder=answer?.status==="PENDING"?"Pendiente":"Sin dato";input.title=current;
    if(multiline)input.rows=Math.min(3,Math.max(2,Math.ceil(current.length/65)));else if(field.kind==="email")input.type="email";
  }
  input.onchange=async()=>{if(!input.value)return;try{await api(`${currentClientBase()}/${state.current.id}/answers/${encodeURIComponent(field.id)}`,{method:"PUT",body:JSON.stringify({value:input.value})});toast("Dato guardado");await openClient(state.current.id,state.currentWorkflow)}catch(error){toast(error.message)}};
  const status=el("span","field-status",answer?{CONFIRMED:"Confirmado",PENDING:"Pendiente",PROPOSED:"Propuesto",CONFLICT:"Conflicto"}[answer.status]:"Faltante");status.title=status.textContent;control.append(input,status);row.append(label,control);return row;
}
function renderSectionCard(section,fields){
  const card=el("article","field-section"),heading=el("div","section-heading"),title=el("div");
  title.append(el("h3",null,section),el("p",null,`${fields.filter(field=>state.current.answers[field.id]?.status==="CONFIRMED").length} de ${fields.length} capturados`));heading.append(title);card.append(heading);
  const grid=el("div","fields-grid");for(const field of fields)grid.append(renderFieldRow(field));card.append(grid);return card;
}
function renderEmploymentSection(fields){
  const card=el("article","field-section employment-section"),heading=el("div","section-heading"),title=el("div");
  title.append(el("h3",null,"Actividades de los últimos 10 años · orden cronológico"),el("p",null,`${fields.filter(field=>state.current.answers[field.id]?.status==="CONFIRMED").length} de ${fields.length} datos capturados`));heading.append(title);card.append(heading);
  const indexes=[...new Set(fields.map(field=>field.id.match(/^employment\.(\d+)\./)?.[1]).filter(Boolean))];
  indexes.sort((left,right)=>{const leftValue=String(state.current.answers[`employment.${left}.from`]?.value||"9999-99"),rightValue=String(state.current.answers[`employment.${right}.from`]?.value||"9999-99");return leftValue.localeCompare(rightValue)});
  const table=el("div","employment-editor"),labels=["Inicio","Fin","Actividad u ocupación","Empresa, institución o situación","Ciudad","Estado"];
  const tableHeader=el("div","employment-table-header");for(const label of labels)tableHeader.append(el("span",null,label));table.append(tableHeader);
  for(const index of indexes){
    const period=el("div","employment-period");
    for(const suffix of ["from","until","activity","organization","city","province"]){const field=fields.find(item=>item.id===`employment.${index}.${suffix}`);period.append(field?renderFieldRow(field,true):el("div","employment-empty","—"))}
    table.append(period);
  }
  card.append(table);return card;
}
function renderInformation(){
  const root=$("#informationSections");root.replaceChildren();const groups=new Map(),query=$("#fieldSearch").value.trim().toLowerCase();let visible=0;
  for(const field of state.current.fields){
    if(field.forms?.includes("INTERNAL"))continue;
    const answer=state.current.answers[field.id],section=displaySection(field),searchText=`${section} ${field.section} ${field.label} ${valueText(answer?.value)}`.toLowerCase();
    if(query&&!searchText.includes(query))continue;if(state.pendingOnly&&answer?.status==="CONFIRMED")continue;
    if(!groups.has(section))groups.set(section,[]);groups.get(section).push(field);visible++;
  }
  $("#visibleFieldCount").textContent=`${visible} dato${visible===1?"":"s"} visibles`;
  let columns=null;
  for(const [section,fields] of groups){
    if(section==="Empleo"){
      columns=null;root.append(renderEmploymentSection(fields));continue;
    }
    if(!columns){columns=el("div","information-columns");root.append(columns)}
    columns.append(renderSectionCard(section,fields));
  }
  if(!visible)root.append(el("div","no-fields","No hay datos que coincidan con este filtro."));
}
function renderDocuments(){
  const root=$("#documentsTab");root.replaceChildren();const header=el("div","documents-header"),copy=el("div");copy.append(el("h3",null,"Documentos del cliente"),el("p",null,"Archivos almacenados en Google Drive."));header.append(copy);
  if(state.current.driveFolderLink){const link=el("a","drive-folder","Abrir carpeta en Drive ↗");link.href=state.current.driveFolderLink;link.target="_blank";link.rel="noopener";header.append(link)}root.append(header);
  const grid=el("div","documents-grid");for(const doc of state.current.documents){const card=el("article","document-card");card.append(el("div","document-icon",doc.mimeType==="application/pdf"?"PDF":"▧"),el("b",null,doc.name),el("span",null,`${(doc.size/1024/1024).toFixed(2)} MB · ${new Date(doc.createdAt).toLocaleDateString("es-MX")}`));const link=el("a",null,"Visualizar en Google Drive ↗");link.href=doc.webViewLink;link.target="_blank";link.rel="noopener";card.append(link);grid.append(card)}
  if(!state.current.documents.length)grid.append(el("p",null,"Todavía no hay documentos guardados."));root.append(grid);$("#documentBadge").textContent=state.current.documents.length;
}
function timelineFieldLabel(fieldId){return state.current?.fields?.find(field=>field.id===fieldId)?.label||fieldId||"dato del expediente"}
function timelinePresentation(item){
  const detail=item.detail||{},field=detail.fieldId?timelineFieldLabel(String(detail.fieldId)):null;
  const known={
    CLIENT_CREATED:["Expediente creado","Se creó el registro del cliente.","system"],
    BOT_STARTED_FROM_CHAT:["Bot iniciado por administrador","El administrador inició el formulario desde WhatsApp.","admin"],
    BOT_STARTED_OR_RESUMED_FROM_CHAT:["Bot reanudado por administrador","El administrador retomó el formulario desde WhatsApp.","admin"],
    CASE_STOPPED_BY_ADMIN:["Bot detenido por administrador","El formulario quedó detenido para este cliente.","admin"],
    CASE_RESUMED_BY_ADMIN:["Expediente reanudado","El administrador permitió continuar el formulario.","admin"],
    CASE_RESUMED:["Conversación reanudada","El cliente volvió al punto pendiente del formulario.","progress"],
    PREAUTHORIZED_INTAKE_STARTED:["Formulario habilitado","El expediente quedó autorizado para comenzar.","admin"],
    CLIENT_INTAKE_CLOSED:["Formulario finalizado",detail.correctionReported?"El cliente terminó e indicó que había una corrección.":"El cliente terminó sin reportar correcciones.","progress"],
    ANSWER_CONFIRMED:["Respuesta registrada",field?`Se guardó: ${field}.`:"Se guardó una respuesta.","incoming"],
    ANSWER_SKIPPED:["Pregunta omitida",field?`El cliente omitió: ${field}.`:"El cliente omitió una pregunta.","incoming"],
    STAFF_ANSWER_SET:["Dato actualizado por el equipo",field?`Se actualizó: ${field}.`:"Se actualizó un dato del expediente.","admin"],
    CLIENT_UPDATED:["Expediente actualizado",`El administrador modificó: ${(detail.fields||[]).map(value=>({displayName:"nombre",notes:"notas",status:"estado"})[value]||value).join(", ")||"información general"}.`,"admin"],
    DOCUMENT_QUEUED:["Documento recibido","El archivo quedó en espera de procesamiento.","document"],
    DOCUMENT_UPLOADED:["Documento guardado","El archivo se guardó correctamente en Google Drive.","document"],
    PASSPORT_RECEIVED:["Pasaporte procesado",`Se revisó el pasaporte y se detectaron ${Number(detail.proposals)||0} datos sugeridos.`,"document"],
    DOCUMENT_REJECTED:["Documento rechazado",shortText(detail.reason)||"No fue posible aceptar el archivo.","error"],
    DOCUMENT_PROCESSING_FAILED:["Error al procesar documento",shortText(detail.error)||"El archivo no pudo procesarse.","error"],
    DRIVE_FOLDER_NAME_SYNCED:["Carpeta de Drive actualizada","La carpeta del cliente se sincronizó correctamente.","document"],
    DRIVE_FOLDER_NAME_SYNC_FAILED:["Error de Google Drive",shortText(detail.error)||"No se pudo actualizar la carpeta.","error"],
    CLIENT_PDF_DOWNLOADED:["PDF descargado","El administrador descargó el expediente.","admin"],
    CLIENT_PDF_EMAILED:["PDF enviado por correo",detail.recipient?`Se envió a ${detail.recipient}.`:"El expediente se envió por correo.","admin"],
    CUSTOM_FIELD_ADDED:["Dato adicional agregado","El administrador agregó información libre.","admin"],
    CUSTOM_FIELD_DELETED:["Dato adicional eliminado","El administrador eliminó información libre.","admin"],
    CLIENT_MESSAGE_RECEIVED:["Mensaje recibido",`${shortText(detail.preview)||"Mensaje sin texto."}${detail.ignoredBecausePaused?" · No se respondió porque el bot estaba pausado.":detail.ignoredBecauseClosed?" · No se respondió porque el expediente estaba cerrado.":""}`,detail.ignoredBecauseClosed||detail.ignoredBecausePaused?"muted":"incoming"],
    BOT_MESSAGE_SENT:["Respuesta enviada",shortText(detail.preview)||"Respuesta automática sin texto.","outgoing"],
    BOT_MESSAGE_SEND_FAILED:["No se pudo enviar la respuesta",shortText(detail.error)||"WhatsApp rechazó el envío.","error"],
    CLIENT_MESSAGE_PROCESSING_FAILED:["Error al procesar mensaje",shortText(detail.error)||"No se pudo procesar el mensaje recibido.","error"],
    AI_INTERPRETATION_COMPLETED:["Respuesta interpretada con IA",`${field?`Campo: ${field}. `:""}Confianza: ${detail.confidence??"—"}%. La validación normal decidió qué guardar.`,"system"],
    AI_INTERPRETATION_FAILED:["La IA no pudo interpretar el mensaje",`${shortText(detail.error)||"OpenAI no respondió correctamente."} · Se utilizó el flujo normal como respaldo.`,"error"],
    MEXICO_PROFILE_DEFAULTS_APPLIED:["Datos predeterminados aplicados",`Se completaron ${Array.isArray(detail.fields)?detail.fields.length:0} valores del perfil México.`,"system"]
  };
  if(known[item.event])return known[item.event];
  const fallback=item.event.toLowerCase().replace(/_/g," ").replace(/^./,letter=>letter.toUpperCase());
  return [fallback,"Actividad registrada por el sistema.",isTimelineError(item)?"error":"system"];
}
function renderActivity(){
  const events=Array.isArray(state.current.auditEvents)?state.current.auditEvents:[],root=$("#activityTimeline");root.replaceChildren();
  const latestIncoming=events.find(item=>item.event==="CLIENT_MESSAGE_RECEIVED")||events.find(item=>["ANSWER_CONFIRMED","ANSWER_SKIPPED"].includes(item.event));
  const latestOutgoing=events.find(item=>item.event==="BOT_MESSAGE_SENT");
  $("#lastIncomingMessage").textContent=latestIncoming?.event==="CLIENT_MESSAGE_RECEIVED"?shortText(latestIncoming.detail?.preview,120):latestIncoming?`Respuesta registrada: ${timelineFieldLabel(latestIncoming.detail?.fieldId)}`:"Sin registro detallado";
  $("#lastIncomingAt").textContent=latestIncoming?formatTimestamp(latestIncoming.createdAt):"Los mensajes se detallarán desde esta actualización";
  $("#lastOutgoingMessage").textContent=latestOutgoing?shortText(latestOutgoing.detail?.preview,120):"Sin registro detallado";
  $("#lastOutgoingAt").textContent=latestOutgoing?formatTimestamp(latestOutgoing.createdAt):"Las respuestas se detallarán desde esta actualización";
  const errors=events.filter(isTimelineError);$("#timelineErrorCount").textContent=String(errors.length);$("#activityBadge").textContent=String(events.length);
  for(const item of events){
    const [title,description,kind]=timelinePresentation(item),entry=el("article",`timeline-entry ${kind}`),marker=el("i"),content=el("div"),heading=el("div","timeline-entry-heading");
    heading.append(el("b",null,title),el("time",null,formatTimestamp(item.createdAt)));content.append(heading,el("p",null,description));entry.append(marker,content);root.append(entry);
  }
  if(!events.length)root.append(el("div","timeline-empty","Todavía no hay actividad registrada para este expediente."));
}
function renderCustom(){
  const root=$("#customFields");root.replaceChildren();for(const item of state.current.customFields){const row=el("div","custom-item");row.append(el("b",null,item.label),el("span",null,item.value));const remove=el("button",null,"Eliminar");remove.onclick=async()=>{await api(`${currentClientBase()}/${state.current.id}/custom-fields/${item.id}`,{method:"DELETE"});await refreshCurrent()};row.append(remove);root.append(row)}
}
async function refreshCurrent(){await openClient(state.current.id,state.currentWorkflow);await (state.currentWorkflow==="usa"?loadUsaClients():loadClients())}
function showTab(tab){document.querySelectorAll(".tabs button").forEach(b=>b.classList.toggle("active",b.dataset.tab===tab));for(const name of ["information","activity","documents","extras"])$(`#${name}Tab`).hidden=name!==tab}

for(const [value,label] of Object.entries(STATUS)){const option=el("option",null,label);option.value=value;$("#statusFilter").append(option)}
document.querySelectorAll(".sort-button").forEach(button=>button.onclick=()=>{const key=button.dataset.sort;state.clientSort=state.clientSort.key===key?{key,direction:state.clientSort.direction==="asc"?"desc":"asc"}:{key,direction:"asc"};renderClients()});
document.querySelectorAll(".workspace-tabs button").forEach(button=>button.onclick=()=>showWorkspace(button.dataset.workspace));
document.querySelectorAll(".help-button").forEach(button=>button.onclick=()=>showWorkspaceHelp(button.dataset.help));
$("#closeWorkspaceHelp").onclick=()=>$("#workspaceHelpDialog").close();
$("#searchInput").oninput=renderClients;$("#statusFilter").onchange=renderClients;$("#closeDialog").onclick=()=>$("#clientDialog").close();$("#closeSetup").onclick=()=>$("#setupDialog").close();
$("#usaSearchInput").oninput=renderUsaClients;
document.querySelectorAll(".tabs button").forEach(button=>button.onclick=()=>showTab(button.dataset.tab));
$("#whatsappStatus").onclick=()=>{if(state.system?.whatsapp.state==="QR")$("#setupDialog").showModal();else toast(state.system?.whatsapp.lastError||`WhatsApp: ${state.system?.whatsapp.state}`)};
$("#whatsappAlertAction").onclick=()=>{if(state.system?.whatsapp?.state==="QR")$("#setupDialog").showModal();else if(state.system?.whatsapp?.lastError)toast(state.system.whatsapp.lastError);else void loadSystem()};
$("#backupButton").onclick=async()=>{try{const data=await api("/api/system/backup",{method:"POST"});toast(`Respaldo creado: ${data.filename}`)}catch(error){toast(error.message)}};
$("#automationToggle").onclick=async()=>{const button=$("#automationToggle"),paused=!Boolean(state.system?.whatsapp?.automationPaused);button.disabled=true;try{const data=await api("/api/system/automation",{method:"POST",body:JSON.stringify({paused})});state.system.whatsapp=data.whatsapp;renderAutomationToggle();toast(paused?"Bot pausado: no enviará mensajes automáticos":"Bot reanudado")}catch(error){toast(error.message)}finally{button.disabled=false}};
$("#aiToggle").onclick=async()=>{const button=$("#aiToggle"),enabled=!Boolean(state.system?.aiConversation?.enabled);button.disabled=true;try{const data=await api("/api/system/ai-conversation",{method:"POST",body:JSON.stringify({enabled})});state.system.aiConversation=data.aiConversation;renderAiToggle();toast(enabled?"Bot con IA activado":"Bot normal activado: no usará IA")}catch(error){toast(error.message)}finally{button.disabled=false}};
$("#detailName").onchange=async()=>{try{await api(`${currentClientBase()}/${state.current.id}/answers/identity.full_name`,{method:"PUT",body:JSON.stringify({value:$("#detailName").value})});toast("Nombre actualizado");await refreshCurrent()}catch(error){toast(error.message)}};
$("#detailStatus").onchange=async()=>{await api(`${currentClientBase()}/${state.current.id}`,{method:"PATCH",body:JSON.stringify({status:$("#detailStatus").value})});toast("Estado actualizado");await (state.currentWorkflow==="usa"?loadUsaClients():loadClients())};
$("#fieldSearch").oninput=renderInformation;
$("#pendingOnly").onclick=()=>{state.pendingOnly=!state.pendingOnly;$("#pendingOnly").classList.toggle("active",state.pendingOnly);$("#pendingOnly").textContent=state.pendingOnly?"Mostrar todos los datos":"Mostrar sólo pendientes";renderInformation()};
$("#emailPdf").onclick=async()=>{
  const email=state.current?.answers?.["contact.email"]?.value;if(!email)return toast("El cliente todavía no tiene correo confirmado");
  if(!window.confirm(`Se enviará el expediente PDF a ${email}. ¿Deseas continuar?`))return;
  const button=$("#emailPdf"),original=button.textContent;button.disabled=true;button.textContent="Enviando…";
  try{const result=await api(`${currentClientBase()}/${state.current.id}/pdf/email`,{method:"POST",body:"{}"});toast(`PDF enviado correctamente a ${result.recipient}`)}
  catch(error){if(["GMAIL_REAUTH_REQUIRED","GOOGLE_NOT_CONNECTED"].includes(error.code)&&error.authorizationUrl){if(window.confirm(`${error.message}\n\n¿Quieres autorizar Google ahora?`))window.location.href=error.authorizationUrl}else toast(error.message)}
  finally{button.textContent=original;button.disabled=!state.current?.answers?.["contact.email"]?.value}
};
$("#saveNotes").onclick=async()=>{await api(`${currentClientBase()}/${state.current.id}`,{method:"PATCH",body:JSON.stringify({notes:$("#detailNotes").value})});toast("Notas guardadas")};
$("#customFieldForm").onsubmit=async(event)=>{event.preventDefault();const form=new FormData(event.target);try{await api(`${currentClientBase()}/${state.current.id}/custom-fields`,{method:"POST",body:JSON.stringify({label:form.get("label"),value:form.get("value")})});event.target.reset();await refreshCurrent();toast("Dato agregado")}catch(error){toast(error.message)}};

await Promise.all([loadSystem(),loadClients(),loadUsaClients()]);setInterval(loadSystem,3000);setInterval(()=>void Promise.all([loadClients(),loadUsaClients()]),10000);
