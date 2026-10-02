use std::io::{self, Write};

pub const PROTOCOL_VERSION: u32 = 1;

pub fn ready(
    nonce: &str,
    provider_id: &str,
    boundary_fingerprint: &str,
    enforcement: &str,
) -> String {
    format!(
        "{{\"type\":\"READY\",\"protocolVersion\":{},\"nonce\":\"{}\",\"providerId\":\"{}\",\"boundaryFingerprint\":\"{}\",\"enforcement\":\"{}\"}}\n",
        PROTOCOL_VERSION,
        escape(nonce),
        escape(provider_id),
        escape(boundary_fingerprint),
        escape(enforcement),
    )
}

pub fn error(nonce: &str, code: &str) -> String {
    format!(
        "{{\"type\":\"ERROR\",\"protocolVersion\":{},\"nonce\":\"{}\",\"code\":\"{}\"}}\n",
        PROTOCOL_VERSION,
        escape(nonce),
        escape(code),
    )
}

pub fn workspace_status(
    nonce: &str,
    provider_id: &str,
    boundary_fingerprint: &str,
    status: &str,
) -> String {
    format!(
        "{{\"type\":\"WORKSPACE_STATUS\",\"protocolVersion\":{},\"nonce\":\"{}\",\"providerId\":\"{}\",\"boundaryFingerprint\":\"{}\",\"status\":\"{}\"}}\n",
        PROTOCOL_VERSION,
        escape(nonce),
        escape(provider_id),
        escape(boundary_fingerprint),
        escape(status),
    )
}

pub fn workspace_prepared(
    nonce: &str,
    provider_id: &str,
    boundary_fingerprint: &str,
    change: &str,
) -> String {
    format!(
        "{{\"type\":\"WORKSPACE_PREPARED\",\"protocolVersion\":{},\"nonce\":\"{}\",\"providerId\":\"{}\",\"boundaryFingerprint\":\"{}\",\"change\":\"{}\"}}\n",
        PROTOCOL_VERSION,
        escape(nonce),
        escape(provider_id),
        escape(boundary_fingerprint),
        escape(change),
    )
}

pub fn write_control(mut control: impl Write, message: &str) -> io::Result<()> {
    control.write_all(message.as_bytes())?;
    control.flush()
}

fn escape(value: &str) -> String {
    value
        .chars()
        .flat_map(|character| match character {
            '\\' => "\\\\".chars().collect::<Vec<_>>(),
            '"' => "\\\"".chars().collect::<Vec<_>>(),
            '\n' => "\\n".chars().collect::<Vec<_>>(),
            '\r' => "\\r".chars().collect::<Vec<_>>(),
            '\t' => "\\t".chars().collect::<Vec<_>>(),
            other => vec![other],
        })
        .collect()
}
