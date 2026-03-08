fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Use vendored protoc — no system installation required.
    let protoc = protoc_bin_vendored::protoc_bin_path().unwrap();
    // SAFETY: build scripts run single-threaded before the crate compiles.
    unsafe { std::env::set_var("PROTOC", &protoc) };

    prost_build::Config::new()
        .compile_protos(&["../../libs/proto/canari.proto"], &["../../libs/proto/"])?;
    println!("cargo:rerun-if-changed=../../libs/proto/canari.proto");
    Ok(())
}

