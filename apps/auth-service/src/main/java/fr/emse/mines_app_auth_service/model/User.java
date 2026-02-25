package fr.emse.mines_app_auth_service.model;

import jakarta.persistence.*;
import java.util.UUID;

@Entity
@Table(name = "users")
public class User {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(unique = true, nullable = false)
    private String username;

    // Password removed as we use OIDC
    
    @Column(nullable = false)
    private String email;

    @OneToMany(mappedBy = "user", cascade = CascadeType.ALL, orphanRemoval = true, fetch = FetchType.EAGER)
    private java.util.List<LinkedAccount> linkedAccounts = new java.util.ArrayList<>();

    public User() {
    }

    public User(String username, String email) {
        this.username = username;
        this.email = email;
    }

    public void addLinkedAccount(LinkedAccount account) {
        linkedAccounts.add(account);
        account.setUser(this);
    }

    public java.util.List<LinkedAccount> getLinkedAccounts() {
        return linkedAccounts;
    }

    public UUID getId() {
        return id;
    }

    public void setId(UUID id) {
        this.id = id;
    }

    public String getUsername() {
        return username;
    }

    public void setUsername(String username) {
        this.username = username;
    }

    public String getEmail() {
        return email;
    }

    public void setEmail(String email) {
        this.email = email;
    }
}
