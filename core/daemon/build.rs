fn main() -> Result<(), Box<dyn std::error::Error>> {
    let out_dir = std::env::var("OUT_DIR")?;
    let protoc_path = protoc_bin_vendored::protoc_bin_path()?;
    std::env::set_var("PROTOC", protoc_path);
    tonic_build::configure()
        .build_server(true)
        .build_client(false)
        .file_descriptor_set_path(format!("{out_dir}/quantum_vault_descriptor.bin"))
        .compile(&["../proto/quantum_vault.proto"], &["../proto"])?;
    Ok(())
}
