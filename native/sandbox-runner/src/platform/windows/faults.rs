//! Test-only fault injection for the Windows restricted-spawn sequence.
//!
//! # Why this is a cargo feature and not a switch
//!
//! Every hook call site and the environment reader below are compiled **only** when the
//! `test-fault-injection` feature is enabled. A default build therefore contains no code path that
//! can weaken the Runner: there is nothing to leave "off", and nothing ambient to abuse. A selector
//! that merely defaulted to disabled would still be reachable in the shipped binary, so
//! `packages/runtime/test/windows-sandbox-faults.e2e.test.ts` asserts this directly by searching
//! both binaries for [`FAULT_ENVIRONMENT_VARIABLE`] and for the `WINDOWS_SANDBOX_FAULT_INJECTED`
//! reason code.
//!
//! # Why a fault is a bounded failure rather than a shortcut
//!
//! [`check`] produces the same kind of `SandboxError` the real step would produce, so every caller
//! follows its ordinary failure path: the specific cleanup for that step, then the bounded reason
//! code on the control channel. A fault injected before a resource exists must leave nothing
//! behind, and a fault injected after one exists must still release it — those are exactly the
//! properties the fault suite measures.

use super::error::SandboxError;
use std::sync::atomic::{AtomicU8, Ordering};

/// The environment variable a `test-fault-injection` build reads once at startup.
pub const FAULT_ENVIRONMENT_VARIABLE: &str = "CAELUSH_SANDBOX_FAULT_STAGE";

/// A stage a fault can be injected at, in the order the spawn sequence reaches them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FaultStage {
    BeforeTokenCreate,
    AfterTokenCreate,
    WorkspaceGrant,
    TempGrant,
    JobCreate,
    JobConfigure,
    ProcessCreate,
    JobAssign,
    Ready,
    ChildStart,
}

/// The accepted stage names. Used both to parse the environment and to name the stages in evidence.
pub const STAGES: [(&str, FaultStage); 10] = [
    ("before-token-create", FaultStage::BeforeTokenCreate),
    ("after-token-create", FaultStage::AfterTokenCreate),
    ("workspace-grant", FaultStage::WorkspaceGrant),
    ("temp-grant", FaultStage::TempGrant),
    ("job-create", FaultStage::JobCreate),
    ("job-configure", FaultStage::JobConfigure),
    ("process-create", FaultStage::ProcessCreate),
    ("job-assign", FaultStage::JobAssign),
    ("ready", FaultStage::Ready),
    ("child-start", FaultStage::ChildStart),
];

const NONE: u8 = u8::MAX;

/// The search marker [`STAGE_MANIFEST`] starts with.
pub const STAGE_MANIFEST_PREFIX: &str = "caelush-fault-stage-manifest:";

/// Every accepted stage name in one searchable constant, terminated by `|`.
///
/// A short stage name such as `ready` also occurs inside ordinary identifiers like `write_ready`, so
/// searching a build for individual names cannot show that the fault stages are absent. This single
/// prefixed marker can: the fault suite reads it out of a build and compares the list exactly, and
/// requires the marker to be missing from the shipped build.
///
/// It is not decoration. [`parse_stage`] reports it on the control channel when a stage name is not
/// recognised — useful in its own right, and the reason the literal survives into a
/// `test-fault-injection` binary rather than being dropped as dead code. An unused constant is
/// elided, which would have made "the build declares its stages" quietly untrue.
pub const STAGE_MANIFEST: &str = concat!(
    "caelush-fault-stage-manifest:",
    "before-token-create,after-token-create,workspace-grant,temp-grant,job-create,",
    "job-configure,process-create,job-assign,ready,child-start",
    "|",
);

static ARMED: AtomicU8 = AtomicU8::new(NONE);

fn position(stage: FaultStage) -> u8 {
    STAGES
        .iter()
        .position(|(_, candidate)| *candidate == stage)
        .expect("every fault stage is listed in STAGES") as u8
}

/// Arms the stage named by [`FAULT_ENVIRONMENT_VARIABLE`], if it is set.
///
/// An unrecognised value is an error rather than a silent no-op: a typo in the fault suite must
/// surface as a bounded failure on the control channel instead of as "the fault did not happen".
pub fn arm_from_environment() -> Result<(), String> {
    let Some(requested) = std::env::var_os(FAULT_ENVIRONMENT_VARIABLE) else {
        return Ok(());
    };
    let stage = parse_stage(&requested.to_string_lossy())?;
    ARMED.store(position(stage), Ordering::SeqCst);
    Ok(())
}

fn parse_stage(name: &str) -> Result<FaultStage, String> {
    STAGES
        .iter()
        .find(|(candidate, _)| *candidate == name)
        .map(|(_, stage)| *stage)
        // The accepted names are quoted back, so a mistyped stage is fixed by reading one message
        // instead of reading this file. This is also what keeps `STAGE_MANIFEST` in the binary.
        .ok_or_else(|| format!("UNKNOWN_FAULT_STAGE accepted={}", accepted_stage_names()))
}

/// Fails with the bounded fault code when `stage` is the armed one.
pub fn check(stage: FaultStage) -> Result<(), SandboxError> {
    if is_armed(ARMED.load(Ordering::SeqCst), stage) {
        return Err(SandboxError::FaultInjected);
    }
    Ok(())
}

/// The names the fault build accepts, ready to be reported.
///
/// Returned without the search marker, so a message that quotes it does not read as serialised data.
pub fn accepted_stage_names() -> &'static str {
    STAGE_MANIFEST
        .strip_prefix(STAGE_MANIFEST_PREFIX)
        .and_then(|rest| rest.strip_suffix('|'))
        .unwrap_or(STAGE_MANIFEST)
}

fn is_armed(armed: u8, stage: FaultStage) -> bool {
    armed == position(stage)
}

#[cfg(test)]
mod tests {
    use super::{
        accepted_stage_names, is_armed, parse_stage, FaultStage, STAGES, STAGE_MANIFEST,
        STAGE_MANIFEST_PREFIX,
    };

    /// The manifest is the only thing the fault suite can search a build for, so it must list
    /// exactly the accepted stages and nothing else.
    #[test]
    fn the_stage_manifest_matches_the_accepted_stages_exactly() {
        assert!(
            STAGE_MANIFEST.starts_with(STAGE_MANIFEST_PREFIX),
            "the manifest must start with the marker the fault suite searches for"
        );
        let declared = accepted_stage_names().split(',').collect::<Vec<_>>();
        let accepted = STAGES.iter().map(|(name, _)| *name).collect::<Vec<_>>();
        assert_eq!(declared, accepted);
    }

    /// The stage table is the only source of stage names, and `position` indexes it, so a stage that
    /// is missing from it would panic at the first `check`. This pins the table's completeness.
    #[test]
    fn every_stage_has_exactly_one_name() {
        let named = [
            FaultStage::BeforeTokenCreate,
            FaultStage::AfterTokenCreate,
            FaultStage::WorkspaceGrant,
            FaultStage::TempGrant,
            FaultStage::JobCreate,
            FaultStage::JobConfigure,
            FaultStage::ProcessCreate,
            FaultStage::JobAssign,
            FaultStage::Ready,
            FaultStage::ChildStart,
        ];
        assert_eq!(STAGES.len(), named.len());
        for stage in named {
            assert_eq!(
                STAGES.iter().filter(|(_, listed)| *listed == stage).count(),
                1,
                "{stage:?} must be listed exactly once"
            );
        }
    }

    #[test]
    fn parses_every_listed_name_and_rejects_anything_else() {
        for (name, stage) in STAGES {
            assert_eq!(parse_stage(name), Ok(stage), "{name} should parse");
        }
        for rejected in ["not-a-stage", ""] {
            let error = parse_stage(rejected).expect_err("{rejected} must not parse");
            // The accepted names are quoted back, which is what makes a typo self-explaining.
            assert_eq!(
                error,
                format!("UNKNOWN_FAULT_STAGE accepted={}", accepted_stage_names())
            );
        }
    }

    #[test]
    fn a_stage_only_matches_itself() {
        const NONE: u8 = u8::MAX;
        assert!(!is_armed(NONE, FaultStage::JobAssign));
        for (name, armed) in STAGES {
            for (other_name, other) in STAGES {
                assert_eq!(
                    is_armed(super::position(armed), other),
                    name == other_name,
                    "arming {name} must not arm {other_name}"
                );
            }
        }
    }
}
