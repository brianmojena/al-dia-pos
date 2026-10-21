import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { AuthProvider } from '/src/context/AuthContext.jsx'
import RequireAuth from '/src/components/RequireAuth.jsx'
import AdminLayout from '/src/components/AdminLayout.jsx'
import Admin from '/src/pages/Admin.jsx'
import '/src/index.css'
const now = new Date().toISOString()
const devices = [
 {device_id:'demo-web-00000001', platform:'web',label:'Safari · iOS',first_seen_at:'2026-09-01 12:00:00',last_seen_at:now,seen_recently:true},
 {device_id:'demo-desktop-0002',platform:'desktop',label:'App de escritorio · Windows',first_seen_at:'2026-07-01 12:00:00',last_seen_at:'2026-08-01 12:00:00',seen_recently:false},
 {device_id:'demo-web-00000003',platform:'web',label:'Chrome · Android',first_seen_at:'2026-09-03 12:00:00',last_seen_at:now,seen_recently:true},
]
const account = (id,email,store_name,role,linked) => ({id,email,store_name,role,created_at:'2026-09-01 12:00:00',device_count:linked.length,recent_device_count:linked.filter(d=>d.seen_recently).length,devices:linked})
const report={generated_at:now,unique_device_count:3,accounts:[
 account(1,'dueno@ejemplo.test','Delicias y Sabores','owner',[devices[0],devices[1]]),
 account(2,'cajero@ejemplo.test','Delicias y Sabores','cajero',[devices[0]]),
 account(3,'mercado@ejemplo.test','Mercado Central','owner',[devices[2]]),
 account(4,'nueva@ejemplo.test','Nueva Tienda','owner',[]),
]}
window.electronAPI={onSyncStatus:()=>()=>{},request:async(method,path)=>path==='/api/auth/me'?{ok:true,status:200,data:{user:{id:999999,email:'vista-previa@ejemplo.test',role:'owner',is_admin:true,store_name:'Vista previa'}}}:path==='/api/admin/devices'?{ok:true,status:200,data:report}:{ok:false,status:403,data:{error:'Esta vista previa solo permite consultar datos de ejemplo.'}}}
createRoot(document.getElementById('root')).render(<AuthProvider><div style={{position:'fixed',bottom:12,right:20,zIndex:20,background:'#fff8e6',border:'1px solid #f5d78a',borderRadius:8,padding:'8px 12px',fontSize:11,color:'#8a6318',boxShadow:'0 2px 12px #0001'}}>Vista previa · Datos de ejemplo</div><MemoryRouter initialEntries={['/admin']}><Routes><Route element={<RequireAuth/>}><Route path="admin" element={<AdminLayout/>}><Route index element={<Admin/>}/><Route path="accounts" element={<Admin view="accounts"/>}/><Route path="devices" element={<Admin view="devices"/>}/></Route><Route path="pos" element={<div style={{padding:40}}><p>Esta es una vista previa del panel administrativo.</p><a href="/admin">Abrir la aplicación real</a></div>}/></Route></Routes></MemoryRouter></AuthProvider>)
