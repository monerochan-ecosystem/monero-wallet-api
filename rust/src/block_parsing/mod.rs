use serde::Serialize;
use serde_json::json;

pub fn convert_to_json<T>(data: &T) -> String
where
    T: Serialize,
{
    match serde_json::to_string(data) {
        Ok(json_string) => json_string,
        Err(e) => {
            let error_message = format!("Error serializing data to JSON: {}", e);
            let error_json = json!({
                "error": error_message
            })
            .to_string();
            error_json
        }
    }
}
