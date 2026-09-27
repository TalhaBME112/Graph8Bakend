import {AppError} from './domain.mjs';
export function graph8ConnectionError(error){
 const status=error?.status??error?.statusCode;
 if(status===401)return new AppError('Graph8 rejected the server API key. Update G8_API_KEY and restart the server.',502);
 if(status===403)return new AppError('Graph8 denied organization access. Check the API key organization and account:read scope.',502);
 if(status===429)return new AppError('Graph8 is rate limiting verification. Wait briefly, then retry connection.',503);
 if(status===0||['TimeoutError','AbortError','TypeError'].includes(error?.name))return new AppError('The application server cannot reach Graph8. Check its outbound network access and retry. This does not mean your API key is invalid.',503);
 if(error instanceof AppError)return error;
 return new AppError('Graph8 verification is temporarily unavailable. Retry connection; existing tender records are preserved.',503);
}
