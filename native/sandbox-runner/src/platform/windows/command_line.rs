use super::error::SandboxError;

pub fn quote_argument(argument: &str) -> Result<String, SandboxError> {
    if argument.contains('\0') {
        return Err(SandboxError::CommandLineBuild);
    }
    let requires_quotes = argument.is_empty()
        || argument
            .chars()
            .any(|character| character.is_whitespace() || character == '"');
    if !requires_quotes {
        return Ok(argument.to_string());
    }

    let mut quoted = String::with_capacity(argument.len() + 2);
    quoted.push('"');
    let mut backslashes = 0usize;
    for character in argument.chars() {
        if character == '\\' {
            backslashes += 1;
            continue;
        }
        if character == '"' {
            quoted.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
            quoted.push('"');
        } else {
            quoted.extend(std::iter::repeat_n('\\', backslashes));
            quoted.push(character);
        }
        backslashes = 0;
    }
    quoted.extend(std::iter::repeat_n('\\', backslashes * 2));
    quoted.push('"');
    Ok(quoted)
}

pub fn build_command_line(program: &str, args: &[String]) -> Result<String, SandboxError> {
    std::iter::once(program)
        .chain(args.iter().map(String::as_str))
        .map(quote_argument)
        .collect::<Result<Vec<_>, _>>()
        .map(|parts| parts.join(" "))
}

#[cfg(test)]
mod tests {
    use super::{build_command_line, quote_argument};

    #[test]
    fn quotes_windows_arguments_using_command_line_to_argv_rules() {
        let cases = [
            ("", r#""""#),
            ("plain", "plain"),
            ("two words", r#""two words""#),
            (r#""quoted""#, r#""\"quoted\"""#),
            (r#"a\"b"#, r#""a\\\"b""#),
            (r#"C:\path with space\"#, r#""C:\path with space\\""#),
            (r#"C:\项目 甲\工具.exe"#, r#""C:\项目 甲\工具.exe""#),
        ];
        for (input, expected) in cases {
            assert_eq!(
                quote_argument(input).as_deref(),
                Ok(expected),
                "input: {input}"
            );
        }
    }

    #[test]
    fn rejects_embedded_nul() {
        assert!(quote_argument("before\0after").is_err());
    }

    #[test]
    fn builds_a_command_line_with_program_as_argv_zero() {
        assert_eq!(
            build_command_line(
                r#"C:\Program Files\工具\app.exe"#,
                &["plain".to_string(), "two words".to_string()]
            )
            .as_deref(),
            Ok(r#""C:\Program Files\工具\app.exe" plain "two words""#)
        );
    }
}
