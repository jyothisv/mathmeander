use sha2::{Digest, Sha256};

fn main() {
    napi_build::setup();

    // Embed the artifact hash of the core THIS addon is compiled against (see Cargo.toml).
    let artifact = mathmeander_core::schema_artifact::artifact_json();
    let hash = Sha256::digest(artifact.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let out_dir = std::env::var("OUT_DIR").expect("OUT_DIR set by cargo");
    std::fs::write(format!("{out_dir}/artifact_hash.txt"), hash).expect("write artifact hash");
}
