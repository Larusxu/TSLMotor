import {invokeCommand} from "./api";

export async function savePoseFile(name:string,body:string,type:string):Promise<string|null>{
 if("__TAURI_INTERNALS__" in window)return invokeCommand<string|null>("save_pose_file",{name,contents:body});
 // Layout preview retains browser downloads; desktop always uses the native dialog.
 const url=URL.createObjectURL(new Blob([body],{type})),a=document.createElement("a");
 a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 return name;
}
