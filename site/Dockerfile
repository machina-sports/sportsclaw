FROM nginx:alpine

COPY index.html /usr/share/nginx/html/index.html
COPY install.sh /usr/share/nginx/html/install.sh

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
