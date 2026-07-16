# Deyo Skill v1.0.11 explicit OpenClaw update consent

- Require Deyo CLI 0.2.2 and move the OpenClaw update manager out of the Skill artifact into the installed npm CLI.
- Enroll only verified owner-qualified managed installs, keep status offline, and check the verified `latest` candidate at most once every 24 hours without installing it.
- Require a fresh user confirmation before `openclaw skills update @casatwy/deyo`; stale candidates are never updated under an earlier confirmation.
- Publish an OpenClaw v2 projection that is slash-invocable only, declares the required `deyo` and `openclaw` binaries, and contains no child-process updater.
