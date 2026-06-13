//! Writes the core-emitted schema artifact, conformance corpus, and artifact hash to
//! disk. ALL content is built by pure mathmeander-core functions; this binary is only the
//! I/O shell (keeping the core literally I/O-free, arch doc §5).
//!
//! Usage: cargo run -p mathmeander-schema-gen -- --out packages/schema/artifact

use std::path::PathBuf;

use sha2::{Digest, Sha256};

fn main() {
    let mut args = std::env::args().skip(1);
    let out_dir = match (args.next().as_deref(), args.next()) {
        (Some("--out"), Some(dir)) => PathBuf::from(dir),
        _ => {
            eprintln!("usage: mathmeander-schema-gen --out <dir>");
            std::process::exit(2);
        }
    };

    std::fs::create_dir_all(&out_dir).expect("create output dir");

    let artifact = mathmeander_core::schema_artifact::artifact_json();
    let conformance = mathmeander_core::schema_artifact::conformance_json();
    let hash = hex(&Sha256::digest(artifact.as_bytes()));

    std::fs::write(out_dir.join("mathmeander-schema.json"), &artifact).expect("write artifact");
    std::fs::write(out_dir.join("conformance.json"), &conformance).expect("write conformance");
    std::fs::write(out_dir.join("artifact-hash.txt"), format!("{hash}\n"))
        .expect("write artifact hash");

    println!(
        "wrote artifact (sha256 {hash}), conformance corpus, and hash file to {}",
        out_dir.display()
    );
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
