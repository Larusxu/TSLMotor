//! Native save dialog: a cancelled dialog never writes a file.
#[tauri::command(async)]
pub fn save_pose_file(name: String, contents: String) -> Result<Option<String>, String> {
    let extension = match std::path::Path::new(&name).extension().and_then(|s| s.to_str()) {
        Some("json") => "json",
        Some("py") => "py",
        _ => return Err("仅支持导出 JSON 或 Python 文件".into()),
    };
    if contents.len() > 2 * 1024 * 1024 { return Err("导出内容超过 2 MB".into()); }
    let Some(path) = save_dialog(&name, extension)? else { return Ok(None); };
    std::fs::write(&path, contents.as_bytes()).map_err(|e| format!("保存失败：{e}"))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[cfg(windows)]
fn save_dialog(name: &str, extension: &str) -> Result<Option<std::path::PathBuf>, String> {
    use std::ffi::c_void;
    // OPENFILENAMEW, as defined by the Windows SDK. Use the system dialog
    // directly so exports need no shell process or additional runtime.
    #[repr(C)]
    struct OpenFileName {
        size:u32, owner:*mut c_void, instance:*mut c_void,
        filter:*const u16, custom_filter:*mut u16, max_custom:u32, filter_index:u32,
        file:*mut u16, max_file:u32, file_title:*mut u16, max_title:u32,
        initial_dir:*const u16, title:*const u16, flags:u32,
        file_offset:u16, extension_offset:u16, default_extension:*const u16,
        custom_data:isize, hook:*mut c_void, template:*const u16,
        reserved:*mut c_void, reserved_word:u32, flags_ex:u32,
    }
    #[link(name="comdlg32")]
    extern "system" {
        fn GetSaveFileNameW(dialog:*mut OpenFileName)->i32;
        fn CommDlgExtendedError()->u32;
    }
    let mut file=vec![0u16;32768];
    let filename:Vec<u16>=name.encode_utf16().collect();
    if filename.len()>=file.len() { return Err("文件名过长".into()); }
    file[..filename.len()].copy_from_slice(&filename);
    let filter:Vec<u16>=format!("{} files\0*.{}\0\0",extension.to_uppercase(),extension).encode_utf16().collect();
    let title:Vec<u16>="保存动作序列\0".encode_utf16().collect();
    let suffix:Vec<u16>=format!("{extension}\0").encode_utf16().collect();
    // All pointer fields not used by this dialog are documented as NULL.
    let mut dialog:OpenFileName=unsafe { std::mem::zeroed() };
    dialog.size=std::mem::size_of::<OpenFileName>() as u32;
    dialog.file=file.as_mut_ptr();dialog.max_file=file.len() as u32;
    dialog.filter=filter.as_ptr();dialog.filter_index=1;
    dialog.title=title.as_ptr();dialog.default_extension=suffix.as_ptr();
    dialog.flags=0x00000002|0x00000008|0x00000800|0x00080000; // overwrite prompt, no cwd change, existing folder, Explorer
    if unsafe { GetSaveFileNameW(&mut dialog) }==0 {
        let error=unsafe { CommDlgExtendedError() };
        return if error==0 { Ok(None) } else { Err(format!("无法打开保存对话框：{error:#x}")) };
    }
    use std::os::windows::ffi::OsStringExt;
    let end=file.iter().position(|c|*c==0).unwrap_or(file.len());
    Ok(Some(std::ffi::OsString::from_wide(&file[..end]).into()))
}

#[cfg(not(windows))]
fn save_dialog(_: &str, _: &str) -> Result<Option<std::path::PathBuf>, String> {
    Err("当前构建仅支持 Windows 原生保存对话框".into())
}
