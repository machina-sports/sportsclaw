FROM nginx:alpine

# The personal-agent homepage (site/landing) is served at /. The built VitePress
# output (staged into site/html by CI; see build-site.yml) is served under
# /opensource/. nginx keeps /install.sh plus legacy doc URLs working.
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY landing/ /usr/share/nginx/html/
COPY html/ /usr/share/nginx/html/opensource/

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
