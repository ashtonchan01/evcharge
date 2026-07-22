open "https://auth.tesla.com/oauth2/v3/authorize?client_id=ebd2cfa8-bcfd-490c-86d4-a4e6d2f7b1bb&redirect_uri=https://ashtonchan01.github.io/callback&response_type=code&scope=openid%20vehicle_device_data%20vehicle_cmds%20vehicle_charging_cmds%20offline_access&state=evcharge123"
echo "Log in, approve, then copy the code= value from the redirected URL."
read -p "Paste the code here: " AUTHCODE
read -p "Paste your Tesla client secret here: " CLIENTSECRET
curl -s https://auth.tesla.com/oauth2/v3/token -d "grant_type=authorization_code&client_id=ebd2cfa8-bcfd-490c-86d4-a4e6d2f7b1bb&client_secret=${CLIENTSECRET}&code=${AUTHCODE}&redirect_uri=https://ashtonchan01.github.io/callback" -H "User-Agent: Mozilla/5.0" > user_token.json
echo "Done. Checking vehicles..."
curl -s https://fleet-api.prd.na.vn.cloud.tesla.com/api/1/vehicles -H "Authorization: Bearer $(python3 -c "import json;print(json.load(open('user_token.json'))['access_token'])")" -H "User-Agent: Mozilla/5.0"
echo ""
