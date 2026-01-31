import "dotenv/config";
import { loadProductConfig } from "./config";

const config = loadProductConfig();
console.log("Resolved products config:");
console.log(JSON.stringify(config, null, 2));
