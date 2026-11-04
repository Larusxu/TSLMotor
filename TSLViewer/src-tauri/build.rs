fn main() {
    tauri_build::build();
    // 测试可执行文件不链接 tauri 生成的 resource.lib，而 tauri 依赖了 comctl32 v6 才有的
    // TaskDialogIndirect，缺清单时进程一启动就 0xc0000139，所以测试目标要自己带清单。
    // Cargo 没有「只对 lib 单测目标」加链接参数的机制（rustc-link-arg-tests 只覆盖声明过的
    // 测试目标），只能对全部目标加 /MANIFEST:EMBED；bin 已经有 resource.lib 里的清单，
    // 再生成一份会报 CVT1100「资源重复」，所以 bin 单独用 /MANIFEST:NO 关掉重复生成。
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'");
        println!("cargo:rustc-link-arg-bins=/MANIFEST:NO");
    }
}