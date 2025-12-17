export type NodeUrlChangedMessage = {
  message: "node_url_changed";
  old_node_url: string;
  new_node_url: string;
};
export type ConnectionErrorMessage = {
  message: "connection_error";
  error: {};
};
export type ConnectionOkMessage = {
  message: "connection_ok";
};
export type ConnectionStatus = {
  status_updates: (
    | ConnectionOkMessage
    | ConnectionErrorMessage
    | NodeUrlChangedMessage
    | undefined
  )[]; // we have multiple messages, because connection status can change + node can change
  last_packet: {
    status: "OK" | "partial read" | "connection failed" | "no_connection_yet";
    bytes_read: number;
    node_url: string;
    timestamp: string;
  };
};
